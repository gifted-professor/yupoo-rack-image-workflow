#!/usr/bin/env python3
"""Deterministic parts of the Yupoo rack-image workflow.

The tool keeps evidence collection, reference selection, generated-image review,
and price graphics separate. Image generation is handled by the Node batch
runner; this module prepares auditable inputs and finalizes approved images.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import re
import shutil
import sys
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 Chrome/138.0 Safari/537.36"
)

SKU_RE = re.compile(
    r"(?<![A-Z0-9])([A-Z]{1,4}\d{3,6}(?:-\d{2,4})?)(?![A-Z0-9])",
    re.I,
)
ORIGINAL_RE = re.compile(
    r'data-origin-src="(https://photo\.yupoo\.com/[^\"]+)"', re.I
)
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


class YupooListingParser(HTMLParser):
    """Extract product album links and a possible next-page link."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.albums: list[dict[str, str | None]] = []
        self.next_page: str | None = None
        self._anchor: dict[str, Any] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        values = dict(attrs)
        classes = set((values.get("class") or "").split())
        href = values.get("href")
        if not href:
            return
        if "album__main" in classes and re.search(r"/albums/\d+", href):
            self.albums.append({"href": href, "title": values.get("title")})
        self._anchor = {"href": href, "classes": classes, "text": []}
        if values.get("rel") == "next" or "pagination__next" in classes:
            self.next_page = href

    def handle_data(self, data: str) -> None:
        if self._anchor is not None:
            self._anchor["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag != "a" or self._anchor is None:
            return
        text = "".join(self._anchor["text"]).strip().lower()
        if text in {"next", "下一页", "下页"}:
            self.next_page = self._anchor["href"]
        self._anchor = None


class YupooPictureParser(HTMLParser):
    """Associate every original image URL with its visible Yupoo date."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.pictures: list[dict[str, Any]] = []
        self.album_title: str | None = None
        self._picture: dict[str, Any] | None = None
        self._picture_div_depth = 0
        self._in_time = False
        self._time_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = set((values.get("class") or "").split())
        if tag == "span" and "showalbumheader__gallerytitle" in classes:
            self.album_title = values.get("data-name") or self.album_title
        if tag == "div" and self._picture is None and {"image__main", "showalbum__children"}.issubset(classes):
            self._picture = {"image_id": values.get("data-id"), "visible_date": None}
            self._picture_div_depth = 1
            return
        if self._picture is None:
            return
        if tag == "div":
            self._picture_div_depth += 1
        elif tag == "img" and values.get("data-origin-src"):
            self._picture.update({
                "url": values.get("data-origin-src"),
                "filename": values.get("alt") or None,
                "width": int(values["data-width"]) if (values.get("data-width") or "").isdigit() else None,
                "height": int(values["data-height"]) if (values.get("data-height") or "").isdigit() else None,
            })
        elif tag == "time":
            self._in_time = True
            self._time_text = []

    def handle_data(self, data: str) -> None:
        if self._in_time:
            self._time_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self._picture is None:
            return
        if tag == "time" and self._in_time:
            raw = "".join(self._time_text).strip()
            match = re.search(r"\b\d{4}-\d{2}-\d{2}\b", raw)
            self._picture["visible_date"] = match.group(0) if match else None
            self._in_time = False
        if tag == "div":
            self._picture_div_depth -= 1
            if self._picture_div_depth == 0:
                if self._picture.get("url"):
                    self.pictures.append(self._picture)
                self._picture = None


def parse_listing_html(raw_html: str, listing_url: str) -> dict[str, Any]:
    parser = YupooListingParser()
    parser.feed(raw_html)
    albums: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in parser.albums:
        absolute = urljoin(listing_url, str(item["href"]))
        album_match = re.search(r"/albums/(\d+)", absolute)
        if not album_match or album_match.group(1) in seen:
            continue
        seen.add(album_match.group(1))
        albums.append({
            "album_id": album_match.group(1),
            "url": absolute,
            "title": item.get("title") or "",
        })
    return {
        "source": listing_url,
        "albums": albums,
        "next_page": urljoin(listing_url, parser.next_page) if parser.next_page else None,
    }


def parse_album_pictures(raw_html: str, album_url: str) -> dict[str, Any]:
    parsed = parse_album_html(raw_html, album_url)
    parser = YupooPictureParser()
    parser.feed(raw_html)
    pictures = parser.pictures
    dates = sorted({picture["visible_date"] for picture in pictures if picture.get("visible_date")})
    album_match = re.search(r"/albums/(\d+)", album_url)
    return {
        **parsed,
        "album_id": album_match.group(1) if album_match else None,
        "title": parser.album_title or parsed["title"],
        "pictures": pictures,
        "picture_dates": dates,
        "picture_date_min": dates[0] if dates else None,
        "picture_date_max": dates[-1] if dates else None,
    }


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def fetch_bytes(url: str, referer: str | None = None) -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if referer:
        headers["Referer"] = referer
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def parse_album_html(raw_html: str, album_url: str) -> dict[str, Any]:
    title_match = TITLE_RE.search(raw_html)
    title = html.unescape(title_match.group(1)).strip() if title_match else "Untitled"
    title = title.split(" | 相册", 1)[0].strip()
    image_urls = list(dict.fromkeys(html.unescape(x) for x in ORIGINAL_RE.findall(raw_html)))
    sku_match = SKU_RE.search(title)
    trailing_number = re.search(r"(?:^|\s)(\d+(?:\.\d+)?)\s*$", title)
    return {
        "album_url": album_url,
        "title": title,
        "sku": sku_match.group(1).upper() if sku_match else None,
        "candidate_cost_price": float(trailing_number.group(1)) if trailing_number else None,
        "candidate_cost_confirmed": False,
        "image_urls": image_urls,
    }


def safe_suffix(url: str) -> str:
    suffix = Path(url.split("?", 1)[0]).suffix.lower()
    return suffix if suffix in {".png", ".jpg", ".jpeg", ".webp"} else ".png"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ingest_album(
    album_url: str,
    output_root: Path,
    cached_html: Path | None = None,
    cached_image_dir: Path | None = None,
) -> Path:
    raw = cached_html.read_bytes() if cached_html else fetch_bytes(album_url)
    parsed = parse_album_pictures(raw.decode("utf-8", errors="replace"), album_url)
    if not parsed["sku"]:
        raise ValueError("Could not extract a SKU from the album title")
    pictures = parsed.pop("pictures")
    parsed.pop("image_urls", None)
    if not pictures:
        raise ValueError("No Yupoo original image URLs found")

    item_dir = output_root / parsed["sku"]
    originals_dir = item_dir / "originals"
    originals_dir.mkdir(parents=True, exist_ok=True)
    (item_dir / "album.html").write_bytes(raw)
    old_manifest = read_json(item_dir / "manifest.json") if (item_dir / "manifest.json").exists() else {}
    old_images = {int(image["index"]): image for image in old_manifest.get("images", []) if image.get("index")}
    cached_images = sorted(cached_image_dir.iterdir()) if cached_image_dir else []

    images: list[dict[str, Any]] = []
    for index, picture in enumerate(pictures, start=1):
        url = picture["url"]
        destination = originals_dir / f"{index:02d}{safe_suffix(url)}"
        previous = old_images.get(index)
        unchanged = destination.exists() and previous and previous.get("source_url") == url
        if not unchanged:
            temporary = destination.with_name(f".{destination.name}.download")
            if cached_image_dir:
                if index > len(cached_images):
                    raise ValueError(f"Missing cached image for index {index}")
                shutil.copyfile(cached_images[index - 1], temporary)
            else:
                temporary.write_bytes(fetch_bytes(url, referer=album_url))
            temporary.replace(destination)
        with Image.open(destination) as image:
            width, height = image.size
        images.append(
            {
                "index": index,
                "path": str(destination.resolve()),
                "source_url": url,
                "visible_date": picture.get("visible_date"),
                "filename": picture.get("filename"),
                "width": width,
                "height": height,
                "sha256": file_sha256(destination),
            }
        )

    manifest = {**parsed, "images": images, "source_revision": hashlib.sha256(raw).hexdigest()}
    manifest_path = item_dir / "manifest.json"
    temporary_manifest = manifest_path.with_name(f".{manifest_path.name}.tmp")
    write_json(temporary_manifest, manifest)
    temporary_manifest.replace(manifest_path)
    create_contact_sheet(manifest_path, item_dir / "contact-sheet.jpg")
    return manifest_path


def ingest_album_command(args: argparse.Namespace) -> None:
    manifest_path = ingest_album(
        args.album_url,
        args.output_root,
        cached_html=args.cached_html,
        cached_image_dir=args.cached_image_dir,
    )
    print(json.dumps(read_json(manifest_path), ensure_ascii=False, indent=2))


def find_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size=size, index=0)
            except OSError:
                continue
    return ImageFont.load_default()


def create_contact_sheet(manifest_path: Path, output_path: Path, columns: int = 3) -> None:
    manifest = read_json(manifest_path)
    tile_width, tile_height, label_height = 480, 480, 70
    rows = math.ceil(len(manifest["images"]) / columns)
    sheet = Image.new("RGB", (columns * tile_width, rows * (tile_height + label_height)), "white")
    draw = ImageDraw.Draw(sheet)
    label_font = find_font(28, bold=True)
    detail_font = find_font(18)

    for item in manifest["images"]:
        slot = item["index"] - 1
        x = (slot % columns) * tile_width
        y = (slot // columns) * (tile_height + label_height)
        with Image.open(item["path"]) as source:
            image = ImageOps.contain(source.convert("RGB"), (tile_width - 24, tile_height - 24))
        px = x + (tile_width - image.width) // 2
        py = y + (tile_height - image.height) // 2
        sheet.paste(image, (px, py))
        draw.rectangle((x, y + tile_height, x + tile_width, y + tile_height + label_height), fill="#111111")
        draw.text((x + 16, y + tile_height + 7), f"#{item['index']:02d}", font=label_font, fill="white")
        draw.text(
            (x + 105, y + tile_height + 13),
            f"{item['width']} x {item['height']}",
            font=detail_font,
            fill="#cccccc",
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path, quality=92, subsampling=0)


def normalize_canvas(
    input_path: Path,
    output_path: Path,
    width: int = 1080,
    height: int = 1440,
) -> dict[str, Any]:
    """Place the complete source on an exact portrait canvas without cropping it."""
    if width <= 0 or height <= 0:
        raise ValueError("Canvas width and height must be positive")
    with Image.open(input_path) as source_file:
        source = ImageOps.exif_transpose(source_file).convert("RGB")
        source.load()
    source_width, source_height = source.size
    background = ImageOps.fit(
        source,
        (width, height),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )
    background = background.filter(
        ImageFilter.GaussianBlur(radius=max(18, int(max(width, height) * 0.025)))
    )
    background = ImageEnhance.Brightness(background).enhance(0.72)
    foreground = ImageOps.contain(
        source,
        (width, height),
        method=Image.Resampling.LANCZOS,
    )
    offset = ((width - foreground.width) // 2, (height - foreground.height) // 2)
    background.paste(foreground, offset)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f".{output_path.stem}.canvas{output_path.suffix}")
    save_format = "PNG" if output_path.suffix.lower() == ".png" else "JPEG"
    save_options = {} if save_format == "PNG" else {"quality": 95, "subsampling": 0}
    background.save(temporary, format=save_format, **save_options)
    temporary.replace(output_path)
    return {
        "input_size": [source_width, source_height],
        "output_size": [width, height],
        "foreground_size": [foreground.width, foreground.height],
        "foreground_offset": list(offset),
        "mode": "contain_blurred_background",
    }


def normalize_canvas_command(args: argparse.Namespace) -> None:
    result = normalize_canvas(args.input, args.output, args.width, args.height)
    print(json.dumps({"output": str(args.output), **result}, ensure_ascii=False, indent=2))


def _contain_on_blurred_tile(source: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Fit the complete source into one collage tile without hiding edge content."""
    tile_width, tile_height = size
    background = ImageOps.fit(
        source,
        size,
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )
    background = background.filter(
        ImageFilter.GaussianBlur(radius=max(10, int(max(size) * 0.022)))
    )
    background = ImageEnhance.Brightness(background).enhance(0.74)
    foreground = ImageOps.contain(
        source,
        size,
        method=Image.Resampling.LANCZOS,
    )
    offset = (
        (tile_width - foreground.width) // 2,
        (tile_height - foreground.height) // 2,
    )
    background.paste(foreground, offset)
    return background


def render_xhs_four_grid_cover(
    front: Path,
    back: Path,
    tryon_front: Path,
    tryon_back: Path,
    output: Path,
    width: int = 1080,
    height: int = 1440,
    gap: int = 12,
    layout: str = "default",
    zoom_top: float = 0.0,
) -> dict[str, Any]:
    """Create a 2x2 XHS cover from priced rack and front/back try-on images.

    Layout options:
    - "default": [front, back, tryon_front, tryon_back] (original)
    - "diagonal": [tryon_front, front, back, tryon_back] (user's diagonal layout)
    - "swap": [tryon_front, tryon_back, front, back] (people on top, clothes on bottom)

    zoom_top: 0.0-1.0, crop factor for rack images (e.g. 0.3 means zoom into top 30%)
    """
    if width <= 0 or height <= 0:
        raise ValueError("Canvas width and height must be positive")
    if gap < 0 or gap >= min(width, height):
        raise ValueError("Gap must fit inside the canvas")
    tile_width = (width - gap) // 2
    tile_height = (height - gap) // 2
    if tile_width <= 0 or tile_height <= 0:
        raise ValueError("Canvas is too small for a four-grid cover")

    # Map layout names to image order
    layout_map = {
        "default": ["priced_front", "priced_back", "tryon_front", "tryon_back"],
        "diagonal": ["tryon_front", "priced_front", "priced_back", "tryon_back"],
        "swap": ["tryon_front", "tryon_back", "priced_front", "priced_back"],
    }

    if layout not in layout_map:
        raise ValueError(f"Unknown layout: {layout}. Choose from: {list(layout_map.keys())}")

    # Map logical names to actual file paths
    image_map = {
        "priced_front": front,
        "priced_back": back,
        "tryon_front": tryon_front,
        "tryon_back": tryon_back,
    }

    layout_order = layout_map[layout]
    inputs = [image_map[name] for name in layout_order]

    positions = [
        (0, 0),
        (tile_width + gap, 0),
        (0, tile_height + gap),
        (tile_width + gap, tile_height + gap),
    ]

    canvas = Image.new("RGB", (width, height), "#f4f1e9")
    source_sizes: list[list[int]] = []

    for input_path, position, logical_name in zip(inputs, positions, layout_order):
        with Image.open(input_path) as source_file:
            source = ImageOps.exif_transpose(source_file).convert("RGB")
            source.load()

        # Apply zoom for rack images (zoom into top portion for detail)
        if zoom_top > 0 and "priced" in logical_name:
            crop_height = int(source.height * zoom_top)
            source = source.crop((0, 0, source.width, crop_height))

        source_sizes.append([source.width, source.height])
        tile = _contain_on_blurred_tile(source, (tile_width, tile_height))
        canvas.paste(tile, position)

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.stem}.four-grid{output.suffix}")
    save_format = "PNG" if output.suffix.lower() == ".png" else "JPEG"
    save_options = {} if save_format == "PNG" else {"quality": 95, "subsampling": 0}
    canvas.save(temporary, format=save_format, **save_options)
    temporary.replace(output)
    return {
        "output_size": [width, height],
        "tile_size": [tile_width, tile_height],
        "gap": gap,
        "source_sizes": source_sizes,
        "layout": layout_order,
        "layout_name": layout,
        "zoom_top": zoom_top,
        "mode": "four_grid_contain_blurred_background",
    }


def render_xhs_cover_command(args: argparse.Namespace) -> None:
    result = render_xhs_four_grid_cover(
        args.front,
        args.back,
        args.tryon_front,
        args.tryon_back,
        args.output,
        args.width,
        args.height,
        args.gap,
        args.layout,
        args.zoom_top,
    )
    print(json.dumps({"output": str(args.output), **result}, ensure_ascii=False, indent=2))


def build_reference_packs(
    manifest_path: Path,
    classification_path: Path,
    scene_library_path: Path,
    output_path: Path,
) -> dict[str, Any]:
    manifest = read_json(manifest_path)
    classification = read_json(classification_path)
    scenes = read_json(scene_library_path)
    by_index = {item["index"]: item for item in manifest["images"]}

    def product_paths(indices: list[int]) -> list[str]:
        return [
            by_index[index]["path"]
            for index in dict.fromkeys(indices)
            if index in by_index
        ]

    brand = classification["brand"].lower()
    scene_brand = {"jordan": "nike"}.get(brand, brand)
    brand_scenes = [
        scene for scene in scenes["scenes"] if scene["brand"] == scene_brand
    ]
    # An unreadable label is a valid, explicitly unconfirmed brand state. Use
    # the neutral mixed scene library rather than guessing a known label's
    # store environment; if it has no dedicated rear rack scene, reuse the
    # neutral front composition for the rear prompt and keep the garment
    # evidence as the sole product authority.
    if not brand_scenes:
        brand_scenes = [scene for scene in scenes["scenes"] if scene["brand"] == "mixed"]
    product_type = classification.get("product_type")

    def scene_rank(scene: dict[str, Any]) -> tuple[int, int, int, int]:
        tags = scene["tags"]
        return (
            int(scene.get("priority", 0)),
            1 if product_type and product_type in tags else 0,
            1 if "close" in tags else 0,
            1 if "stocked" in tags else 0,
        )

    front_scenes = sorted(
        [scene for scene in brand_scenes if "front" in scene["tags"]],
        key=scene_rank,
        reverse=True,
    )[:1]
    back_scenes = sorted(
        [scene for scene in brand_scenes if "back" in scene["tags"] and "pose-only" not in scene["tags"]],
        key=scene_rank,
        reverse=True,
    )[:1]
    if not back_scenes and front_scenes:
        back_scenes = front_scenes[:1]

    roles = classification["roles"]
    front_indices = (
        roles.get("front_full", [])
        + roles.get("logo_detail", [])
        + roles.get("front_structure_detail", [])
    )[:3]
    back_indices = (
        roles.get("back_full", [])
        + roles.get("back_structure_detail", [])
        + roles.get("shared_structure_detail", [])
    )[:3]

    reference_status = classification.get(
        "reference_image_status",
        "unusable" if classification.get("physical_image_status") == "missing" else "usable",
    )
    skip_unusable = reference_status == "unusable"
    packs: dict[str, Any] = {
        "sku": manifest["sku"],
        "model_input_limit": 5,
        "sign_reference": scenes.get("sign_reference"),
        "front": {
            "status": (
                "SKIP_UNUSABLE_REFERENCES"
                if skip_unusable
                else "READY" if front_indices and front_scenes else "BLOCKED"
            ),
            "scene_references": [scene["path"] for scene in front_scenes],
            "product_references": product_paths(front_indices),
        },
        "back": {
            "status": (
                "SKIP_UNUSABLE_REFERENCES"
                if skip_unusable
                else (
                    "READY"
                    if roles.get("back_full")
                    and roles.get("back_structure_detail")
                    and back_scenes
                    else "BLOCKED_NO_BACK_DETAILS"
                )
            ),
            "scene_references": [scene["path"] for scene in back_scenes],
            "product_references": product_paths(back_indices),
        },
        "yupoo_detail_evidence": [],
    }

    for detail_name in (
        "logo_detail",
        "collar_detail",
        "hem_pocket_detail",
        "sleeve_detail",
        "fabric_detail",
        "tag_detail",
    ):
        for index in roles.get(detail_name, []):
            supporting = (roles.get("front_full", []) + [index])[:3]
            packs["yupoo_detail_evidence"].append(
                {
                    "name": detail_name,
                    "status": "USE_ORIGINAL_YUPOO_IMAGE",
                    "product_references": product_paths(supporting),
                }
            )

    for pack in [packs["front"], packs["back"]]:
        total = (
            len(pack["scene_references"])
            + len(pack["product_references"])
            + (1 if packs.get("sign_reference") else 0)
        )
        if total > 5:
            raise ValueError(f"Reference pack exceeds model limit: {total}")

    write_json(output_path, packs)
    return packs


@dataclass(frozen=True)
class PriceResult:
    cost_price: Decimal
    sale_price: Decimal
    list_price: Decimal | None
    discount: Decimal | None


def round_retail(value: Decimal, ending: int, step: int) -> Decimal:
    bucket = math.ceil(float(value) / step) * step
    return Decimal(max(ending, bucket - (step - ending)))


def calculate_price(cost_price: float | str, rules: dict[str, Any]) -> PriceResult:
    cost = Decimal(str(cost_price))
    fixed_markup = Decimal(str(rules.get("fixed_markup", 0)))
    enforce_cost_ratio_ceiling = False
    if "cost_ratio_target" in rules:
        cost_ratio = Decimal(str(rules["cost_ratio_target"]))
        if not Decimal("0") < cost_ratio <= Decimal("1"):
            raise ValueError("cost_ratio_target must be greater than 0 and at most 1")
        raw_sale = cost / cost_ratio + fixed_markup
        enforce_cost_ratio_ceiling = True
    else:
        multiplier = Decimal(str(rules["cost_multiplier"]))
        raw_sale = cost * multiplier + fixed_markup
    sale = round_retail(
        raw_sale,
        int(rules.get("price_ending", 9)),
        int(rules.get("round_step", 10)),
    )
    if enforce_cost_ratio_ceiling and sale < raw_sale:
        sale += Decimal(str(rules.get("round_step", 10)))
    list_price = None
    discount = None
    if "target_discount" in rules:
        target_discount = Decimal(str(rules["target_discount"]))
        list_price = round_retail(
            sale / target_discount,
            int(rules.get("price_ending", 9)),
            int(rules.get("round_step", 10)),
        )
        discount = (sale / list_price * Decimal("10")).quantize(
            Decimal("0.1"), rounding=ROUND_HALF_UP
        )
    return PriceResult(cost, sale, list_price, discount)


def compact_sku(sku: str) -> str:
    """Use the searchable style code in customer-facing copy."""
    return sku.split("-", 1)[0].upper()


def clean_fact_values(value: Any) -> list[str]:
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    cleaned: list[str] = []
    for item in values:
        text = str(item).strip()
        if text and text not in cleaned:
            cleaned.append(text)
    return cleaned


SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL"]
SIZE_ALIASES = {"2XL": "XXL", "XXXL": "3XL"}


def extract_sizes_from_title(title: str) -> list[str]:
    """Expand common Yupoo size ranges such as S-XXL without inventing sizes."""
    normalized = title.upper().replace("–", "-").replace("—", "-")
    range_match = re.search(
        r"(?<![A-Z0-9])(XXS|XS|S|M|L|XL|XXL|2XL|3XL|XXXL|4XL|5XL)\s*-\s*"
        r"(XXS|XS|S|M|L|XL|XXL|2XL|3XL|XXXL|4XL|5XL)(?![A-Z0-9])",
        normalized,
    )
    if range_match:
        start = SIZE_ALIASES.get(range_match.group(1), range_match.group(1))
        end = SIZE_ALIASES.get(range_match.group(2), range_match.group(2))
        if start in SIZE_ORDER and end in SIZE_ORDER:
            left, right = SIZE_ORDER.index(start), SIZE_ORDER.index(end)
            if left <= right:
                return SIZE_ORDER[left : right + 1]
    tokens = re.findall(
        r"(?<![A-Z0-9])(XXS|XS|S|M|L|XL|XXL|2XL|3XL|XXXL|4XL|5XL)(?![A-Z0-9])",
        normalized,
    )
    return list(dict.fromkeys(SIZE_ALIASES.get(token, token) for token in tokens))


def build_product_facts(
    manifest: dict[str, Any],
    classification: dict[str, Any],
    pricing_status: dict[str, Any],
) -> dict[str, Any]:
    """Create one evidence-oriented fact record shared by image and publishing work."""
    supplied = classification.get("facts", {})
    review_state = classification.get("review_state", "draft")
    fact_fields = (
        "season",
        "gender",
        "product_line",
        "materials",
        "features",
        "use_cases",
        "styles",
        "sizes",
        "colors",
        "tags",
    )
    facts: dict[str, Any] = {
        "version": 1,
        "status": "VERIFIED" if review_state == "manual_verified" else "DRAFT",
        "sku": manifest["sku"],
        "style_code": compact_sku(manifest["sku"]),
        "brand": classification["brand"].lower(),
        "brand_display": str(
            supplied.get("brand_display") or classification["brand"]
        ).strip(),
        "product_type": classification.get("product_type"),
        "category": str(supplied.get("category") or "").strip() or None,
        "source": {
            "yupoo_album_url": manifest.get("album_url"),
            "yupoo_album_title": manifest.get("title"),
            "official_url": supplied.get("official_url"),
            "official_title": supplied.get("official_title"),
        },
        "pricing": {
            "status": pricing_status["status"],
            "cost_price": pricing_status.get("cost_price"),
            "sale_price": pricing_status.get("sale_price"),
        },
    }
    for field in fact_fields:
        facts[field] = clean_fact_values(supplied.get(field))
    if not facts["sizes"]:
        facts["sizes"] = extract_sizes_from_title(manifest.get("title") or "")
    facts["reference_image_status"] = classification.get(
        "reference_image_status",
        "unusable" if classification.get("physical_image_status") == "missing" else "usable",
    )
    return facts


def compose_publish_title(facts: dict[str, Any]) -> str:
    """Build a compact title exclusively from verified fact fields."""
    segments = [facts["brand_display"]]
    for field in (
        "season",
        "gender",
        "product_line",
        "materials",
        "features",
        "use_cases",
        "styles",
    ):
        segments.extend(facts.get(field, []))
    if facts.get("category"):
        segments.append(facts["category"])
    segments.append(facts["style_code"])
    return "".join(dict.fromkeys(segment for segment in segments if segment))


def derive_publish_tags(
    facts: dict[str, Any], publishing: dict[str, Any]
) -> list[str]:
    allowed = set(publishing.get("existing_tags", []))
    candidates = list(facts.get("tags", []))
    brand_tag = publishing.get("brand_tags", {}).get(facts.get("brand"))
    if brand_tag:
        candidates.append(brand_tag)
    category = facts.get("category") or ""
    for needle, tag in publishing.get("category_tags", {}).items():
        if needle in category:
            candidates.append(tag)
    return list(dict.fromkeys(tag for tag in candidates if tag in allowed))


def build_variants(facts: dict[str, Any], inventory: int) -> list[dict[str, Any]]:
    colors = clean_fact_values(facts.get("colors"))
    sizes = clean_fact_values(facts.get("sizes"))
    # A sellable variant requires every configured variant dimension to be
    # evidence-backed. Never turn an unknown color into a null-color SKU or
    # claim inventory before both color and size have been confirmed.
    if not colors or not sizes:
        return []
    return [
        {"color": color, "size": size, "inventory": inventory}
        for color in colors
        for size in sizes
    ]


def build_publish_draft(
    facts: dict[str, Any], publishing: dict[str, Any] | None = None
) -> dict[str, Any]:
    publishing = publishing or {}
    defaults = publishing.get("defaults", {})
    inventory_per_variant = int(defaults.get("inventory_per_variant", 10))
    blockers = [
        "FRONT_IMAGE_NOT_APPROVED",
        "BACK_IMAGE_NOT_APPROVED",
        "TRYON_MAIN_IMAGE_NOT_APPROVED",
        "TRYON_DETAIL_IMAGE_NOT_APPROVED",
        "TRYON_BACK_IMAGE_NOT_APPROVED",
    ]
    if facts["status"] != "VERIFIED":
        blockers.insert(0, "FACTS_NOT_MANUALLY_VERIFIED")
    if not facts.get("category"):
        blockers.append("CATEGORY_NOT_CONFIRMED")
    if facts["pricing"]["status"] != "READY":
        blockers.append("COST_NOT_CONFIRMED")
    if not facts.get("sizes"):
        blockers.append("SIZES_NOT_CONFIRMED")
    if not facts.get("colors"):
        blockers.append("COLORS_NOT_CONFIRMED")
    if facts.get("reference_image_status") == "unusable":
        blockers.extend([
            "SKIP_UNUSABLE_REFERENCES",
            "FRONT_RACK_IMAGE_UNAVAILABLE",
            "BACK_RACK_IMAGE_UNAVAILABLE",
        ])

    title = compose_publish_title(facts)
    short_name = "".join(
        part
        for part in (
            facts["brand_display"],
            "".join(facts.get("gender", [])),
            facts.get("category") or facts.get("product_type") or "",
            facts["style_code"],
        )
        if part
    )[:50]
    description_parts = [
        "".join(facts.get("materials", [])),
        "".join(facts.get("features", [])),
        "".join(facts.get("use_cases", [])),
        "".join(facts.get("styles", [])),
    ]
    description = "，".join(part for part in description_parts if part)

    return {
        "version": 1,
        "status": "DRAFT_REVIEW",
        "blockers": blockers,
        "sku": facts["sku"],
        "style_code": facts["style_code"],
        "title": title,
        "short_name": short_name,
        "description": description,
        "category": facts.get("category"),
        "tags": derive_publish_tags(facts, publishing),
        "sizes": facts.get("sizes", []),
        "colors": facts.get("colors", []),
        "variants": build_variants(facts, inventory_per_variant),
        "inventory_per_variant": inventory_per_variant,
        "cost_price": facts["pricing"].get("cost_price"),
        "sale_price": facts["pricing"].get("sale_price"),
        "image_order": [
            "front_rack",
            "back_rack",
            "tryon_main",
            "tryon_detail",
            "tryon_back",
            "yupoo_front",
            "yupoo_back",
            "yupoo_details",
        ],
        "shipping": {
            "template_name": defaults.get(
                "shipping_template_name", "全国统一运费 10 元"
            ),
            "fee": float(defaults.get("shipping_fee", 10)),
        },
        "publish_target": publishing.get("target", "szwego"),
        "final_action": defaults.get(
            "final_action", "HUMAN_CONFIRM_REQUIRED"
        ),
    }


def render_price_badge(
    input_path: Path,
    output_path: Path,
    price: PriceResult,
    position: str = "top-left",
    style: str = "orange-board",
) -> None:
    with Image.open(input_path) as source:
        image = source.convert("RGB")
    draw = ImageDraw.Draw(image)
    width, height = image.size
    margin = int(width * 0.035)

    if style == "green-tag":
        badge_width = int(width * 0.18)
        badge_height = int(height * 0.085)
        x = (width - badge_width) // 2
        y = int(height * 0.055)
        line_x = x + badge_width // 2
        draw.line((line_x, max(0, y - int(height * 0.045)), line_x, y), fill="#1D1D1D", width=max(3, int(width * 0.004)))
        draw.rounded_rectangle(
            (x, y, x + badge_width, y + badge_height),
            radius=max(8, int(width * 0.008)),
            fill="#65B32E",
            outline="#E9F7D7",
            width=max(2, int(width * 0.003)),
        )
        title_font = find_font(max(17, int(width * 0.020)), bold=True)
        price_font = find_font(max(28, int(width * 0.032)), bold=True)
        small_font = find_font(max(12, int(width * 0.014)))
        draw.text((x + margin * 0.4, y + margin * 0.25), "店长推荐", font=title_font, fill="white")
        draw.text((x + margin * 0.55, y + badge_height * 0.38), f"特价 ¥{int(price.sale_price)}", font=price_font, fill="white")
        draw.text((x + margin * 0.55, y + badge_height * 0.78), "门店特惠", font=small_font, fill="#163A0B")
    else:
        badge_width = int(width * 0.32)
        badge_height = int(height * 0.12)
        if position == "top-center":
            x = (width - badge_width) // 2
        elif position.endswith("right"):
            x = width - badge_width - margin
        else:
            x = margin
        y = margin
        orange = "#F15A2A" if style == "orange-board" else "#E53935"
        draw.rectangle(
            (x, y, x + badge_width, y + badge_height),
            fill=orange,
            outline="#DADADA",
            width=max(3, int(width * 0.004)),
        )
        footer_height = int(badge_height * 0.22)
        draw.rectangle(
            (x, y + badge_height - footer_height, x + badge_width, y + badge_height),
            fill="#292929",
        )
        title_font = find_font(max(18, int(width * 0.021)), bold=True)
        price_font = find_font(max(38, int(width * 0.050)), bold=True)
        small_font = find_font(max(13, int(width * 0.016)))
        draw.text((x + margin * 0.5, y + margin * 0.3), "限时特惠", font=title_font, fill="white")
        draw.text((x + margin * 0.5, y + badge_height * 0.36), f"特价 ¥{int(price.sale_price)}", font=price_font, fill="white")
        draw.text((x + margin * 0.5, y + badge_height - footer_height + 3), "门店活动价", font=small_font, fill="white")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, quality=95, subsampling=0)


def parse_box(value: str) -> tuple[int, int, int, int]:
    parts = tuple(int(part.strip()) for part in value.split(","))
    if len(parts) != 4:
        raise ValueError("box must be x1,y1,x2,y2")
    return parts


def detect_physical_sign_boxes(
    input_path: Path,
) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
    """Detect the largest top-of-frame orange panel and its black footer."""
    with Image.open(input_path) as source:
        image = source.convert("RGB")
    width, height = image.size
    scale = max(1, math.ceil(width / 320))
    small = image.resize(
        (max(1, width // scale), max(1, height // scale)),
        Image.Resampling.BILINEAR,
    )
    sw, sh = small.size
    pixels = small.load()
    top_limit = max(1, int(sh * 0.46))
    mask = bytearray(sw * top_limit)
    for y in range(top_limit):
        for x in range(sw):
            red, green, blue = pixels[x, y]
            if red >= 145 and red - green >= 25 and red - blue >= 25:
                mask[y * sw + x] = 1

    visited = bytearray(len(mask))
    candidates: list[tuple[int, int, int, int, int]] = []
    for start in range(len(mask)):
        if not mask[start] or visited[start]:
            continue
        stack = [start]
        visited[start] = 1
        area = 0
        min_x = max_x = start % sw
        min_y = max_y = start // sw
        while stack:
            point = stack.pop()
            x = point % sw
            y = point // sw
            area += 1
            min_x, max_x = min(min_x, x), max(max_x, x)
            min_y, max_y = min(min_y, y), max(max_y, y)
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < sw and 0 <= ny < top_limit:
                    neighbor = ny * sw + nx
                    if mask[neighbor] and not visited[neighbor]:
                        visited[neighbor] = 1
                        stack.append(neighbor)
        component_width = max_x - min_x + 1
        component_height = max_y - min_y + 1
        if (
            area >= 100
            and component_width >= component_height * 1.1
            and min_y <= int(sh * 0.18)
        ):
            candidates.append((area, min_x, min_y, max_x + 1, max_y + 1))

    if not candidates:
        raise ValueError("Could not automatically detect the orange physical sign panel")
    _, left, top, right, bottom = max(candidates)
    upper_box = (
        left * scale,
        top * scale,
        min(width, right * scale),
        min(height, bottom * scale),
    )

    orange_height = upper_box[3] - upper_box[1]
    inset = max(2, int((upper_box[2] - upper_box[0]) * 0.03))
    scan_left = upper_box[0] + inset
    scan_right = upper_box[2] - inset
    scan_start = upper_box[3]
    scan_end = min(height, upper_box[3] + max(30, int(orange_height * 1.20)))
    dark_rows: list[int] = []
    for y in range(scan_start, scan_end):
        dark = 0
        total = max(1, scan_right - scan_left)
        for x in range(scan_left, scan_right):
            red, green, blue = image.getpixel((x, y))
            if max(red, green, blue) <= 115 and max(red, green, blue) - min(red, green, blue) <= 45:
                dark += 1
        if dark / total >= 0.32:
            dark_rows.append(y)

    groups: list[list[int]] = []
    for row in dark_rows:
        if not groups or row != groups[-1][-1] + 1:
            groups.append([row])
        else:
            groups[-1].append(row)
    groups = [group for group in groups if len(group) >= max(6, int(orange_height * 0.08))]
    if not groups:
        footer_top = min(height - 1, upper_box[3] + max(2, int(orange_height * 0.03)))
        footer_bottom = min(height, footer_top + max(24, int(orange_height * 0.48)))
        lower_box = (upper_box[0], footer_top, upper_box[2], footer_bottom)
    else:
        footer = groups[0]
        lower_box = (upper_box[0], footer[0], upper_box[2], footer[-1] + 1)
    return upper_box, lower_box


def centered_text(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int, int],
    y_offset: int = 0,
) -> None:
    left, top, right, bottom = box
    bounds = draw.textbbox((0, 0), text, font=font)
    text_width = bounds[2] - bounds[0]
    text_height = bounds[3] - bounds[1]
    x = left + (right - left - text_width) // 2
    y = top + (bottom - top - text_height) // 2 - bounds[1] + y_offset
    draw.text((x, y), text, font=font, fill=fill)


def render_physical_sign_text(
    input_path: Path,
    output_path: Path,
    sale_price: int,
    upper_box: tuple[int, int, int, int],
    lower_box: tuple[int, int, int, int],
    category: str,
    category_en: str,
) -> None:
    with Image.open(input_path) as source:
        image = source.convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    upper_height = upper_box[3] - upper_box[1]
    lower_height = lower_box[3] - lower_box[1]
    small_font = find_font(max(18, int(upper_height * 0.18)), bold=True)
    price_font = find_font(max(38, int(upper_height * 0.42)), bold=True)
    category_font = find_font(max(18, int(lower_height * 0.42)), bold=True)
    category_en_font = find_font(max(11, int(lower_height * 0.22)))

    upper_mid = upper_box[1] + upper_height // 2
    centered_text(
        draw,
        (upper_box[0], upper_box[1], upper_box[2], upper_mid),
        "门店特惠",
        small_font,
        (248, 248, 248, 238),
        y_offset=3,
    )
    centered_text(
        draw,
        (upper_box[0], upper_mid - 8, upper_box[2], upper_box[3]),
        f"¥{sale_price}",
        price_font,
        (250, 250, 250, 245),
        y_offset=-2,
    )
    lower_mid = lower_box[1] + int(lower_height * 0.58)
    centered_text(
        draw,
        (lower_box[0], lower_box[1], lower_box[2], lower_mid),
        category,
        category_font,
        (245, 245, 245, 238),
        y_offset=2,
    )
    centered_text(
        draw,
        (lower_box[0], lower_mid - 2, lower_box[2], lower_box[3]),
        category_en,
        category_en_font,
        (235, 235, 235, 230),
        y_offset=-1,
    )
    overlay = overlay.filter(ImageFilter.GaussianBlur(radius=0.35))
    result = Image.alpha_composite(image, overlay).convert("RGB")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path, quality=95, subsampling=0)


def discover_album_command(args: argparse.Namespace) -> None:
    """Discover one Yupoo listing page and inspect every product detail page."""
    raw = args.cached_html.read_bytes() if args.cached_html else fetch_bytes(args.album_url)
    listing = parse_listing_html(raw.decode("utf-8", errors="replace"), args.album_url)
    products: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    for album in listing["albums"][: args.max_products]:
        try:
            fixture = (
                args.cached_product_dir / f"{album['album_id']}.html"
                if args.cached_product_dir
                else None
            )
            product_raw = fixture.read_bytes() if fixture else fetch_bytes(album["url"], referer=args.album_url)
            parsed = parse_album_pictures(product_raw.decode("utf-8", errors="replace"), album["url"])
            visible_dates = [
                picture["visible_date"]
                for picture in parsed["pictures"]
                if picture.get("visible_date")
            ]
            in_range = [date for date in visible_dates if args.from_date <= date <= args.to_date]
            included = bool(in_range)
            warning = None
            if not visible_dates:
                warning = "ALL_PICTURE_DATES_MISSING"
            if not parsed.get("sku"):
                warning = "SKU_NOT_FOUND"
            product = {
                "sku": parsed.get("sku"),
                "album_id": parsed.get("album_id"),
                "url": album["url"],
                "title": parsed.get("title") or album.get("title") or "",
                "pictures": parsed["pictures"],
                "picture_dates": parsed["picture_dates"],
                "picture_date_min": parsed["picture_date_min"],
                "picture_date_max": parsed["picture_date_max"],
                "in_range_picture_count": len(in_range),
                "image_count": len(parsed["pictures"]),
                "included": included and bool(parsed.get("sku")),
                "warning": warning,
            }
            products.append(product)
            if warning:
                warnings.append({"album_id": album["album_id"], "url": album["url"], "warning": warning})
        except Exception as error:
            warnings.append({
                "album_id": album["album_id"],
                "url": album["url"],
                "warning": "PRODUCT_DETAIL_FAILED",
                "detail": str(error),
            })
    print(json.dumps({
        "source": args.album_url,
        "from_date": args.from_date,
        "to_date": args.to_date,
        "products": products,
        "next_page": listing["next_page"],
        "warnings": warnings,
    }, ensure_ascii=False, indent=2))


def run_sample(args: argparse.Namespace) -> None:
    manifest_path = ingest_album(
        args.album_url,
        args.output_root,
        cached_html=args.cached_html,
    )
    item_dir = manifest_path.parent
    packs = build_reference_packs(
        manifest_path,
        args.classification,
        args.scenes,
        item_dir / "reference-packs.json",
    )
    manifest = read_json(manifest_path)
    pricing_config = read_json(args.pricing)
    pricing_status: dict[str, Any] = {
        "candidate_cost_price": manifest.get("candidate_cost_price"),
        "candidate_cost_confirmed": manifest.get("candidate_cost_confirmed", False),
        "status": "BLOCKED_UNCONFIRMED_COST",
        "rules": pricing_config,
    }
    if args.confirm_cost and manifest.get("candidate_cost_price") is not None:
        result = calculate_price(manifest["candidate_cost_price"], pricing_config)
        pricing_status.update(
            {
                "status": "READY",
                "candidate_cost_confirmed": True,
                "cost_price": float(result.cost_price),
                "sale_price": float(result.sale_price),
            }
        )
        if result.list_price is not None:
            pricing_status["list_price"] = float(result.list_price)
        if result.discount is not None:
            pricing_status["discount"] = float(result.discount)
    write_json(item_dir / "pricing.json", pricing_status)
    classification = read_json(args.classification)
    publishing = read_json(args.publishing)
    product_facts = build_product_facts(manifest, classification, pricing_status)
    publish_draft = build_publish_draft(product_facts, publishing)
    write_json(item_dir / "product-facts.json", product_facts)
    write_json(item_dir / "publish-draft.json", publish_draft)
    print(json.dumps({
        "manifest": str(manifest_path),
        "packs": packs,
        "pricing": pricing_status,
        "product_facts": product_facts,
        "publish_draft": publish_draft,
    }, ensure_ascii=False, indent=2))


def prepare_item_command(args: argparse.Namespace) -> None:
    """Build deterministic packs/facts for an already-ingested item.

    This is intentionally separate from ``run``: full-run orchestration must
    not redownload or rewrite Yupoo originals merely because a classification
    or prompt batch is being resumed.
    """
    manifest_path = args.manifest.resolve()
    item_dir = manifest_path.parent
    manifest = read_json(manifest_path)
    classification = read_json(args.classification)
    pricing_config = read_json(args.pricing)
    pricing_status: dict[str, Any] = {
        "candidate_cost_price": manifest.get("candidate_cost_price"),
        "candidate_cost_confirmed": False,
        "status": "BLOCKED_UNCONFIRMED_COST",
        "rules": pricing_config,
    }
    if args.confirm_cost and manifest.get("candidate_cost_price") is not None:
        result = calculate_price(manifest["candidate_cost_price"], pricing_config)
        pricing_status.update(
            {
                "status": "READY",
                "candidate_cost_confirmed": True,
                "confirmed_from": "Yupoo album title",
                "cost_price": float(result.cost_price),
                "sale_price": float(result.sale_price),
            }
        )
        if result.list_price is not None:
            pricing_status["list_price"] = float(result.list_price)
        if result.discount is not None:
            pricing_status["discount"] = float(result.discount)
    packs = build_reference_packs(
        manifest_path,
        args.classification,
        args.scenes,
        item_dir / "reference-packs.json",
    )
    publishing = read_json(args.publishing)
    product_facts = build_product_facts(manifest, classification, pricing_status)
    publish_draft = build_publish_draft(product_facts, publishing)
    write_json(item_dir / "pricing.json", pricing_status)
    write_json(item_dir / "product-facts.json", product_facts)
    write_json(item_dir / "publish-draft.json", publish_draft)
    print(json.dumps({
        "sku": manifest["sku"],
        "packs": packs,
        "pricing": pricing_status,
        "product_facts": product_facts,
        "publish_draft": publish_draft,
    }, ensure_ascii=False, indent=2))


def render_badge_command(args: argparse.Namespace) -> None:
    config = read_json(args.pricing)
    result = calculate_price(args.cost, config)
    render_price_badge(args.input, args.output, result, args.position, args.style)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "cost": float(result.cost_price),
                "sale": float(result.sale_price),
                "list": float(result.list_price) if result.list_price is not None else None,
                "discount": float(result.discount) if result.discount is not None else None,
                "style": args.style,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def render_physical_sign_command(args: argparse.Namespace) -> None:
    config = read_json(args.pricing)
    result = calculate_price(args.cost, config)
    if args.upper_box and args.lower_box:
        upper_box = parse_box(args.upper_box)
        lower_box = parse_box(args.lower_box)
    elif not args.upper_box and not args.lower_box:
        upper_box, lower_box = detect_physical_sign_boxes(args.input)
    else:
        raise ValueError("Provide both --upper-box and --lower-box, or omit both for auto detection")
    render_physical_sign_text(
        args.input,
        args.output,
        int(result.sale_price),
        upper_box,
        lower_box,
        args.category,
        args.category_en,
    )
    print(json.dumps({
        "output": str(args.output),
        "sale": int(result.sale_price),
        "upper_box": upper_box,
        "lower_box": lower_box,
    }, ensure_ascii=False, indent=2))


def resolve_from_root(project_root: Path, value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else project_root / path


def finalize_review(
    review_path: Path,
    pricing_path: Path,
    project_root: Path,
    report_path: Path | None = None,
) -> dict[str, Any]:
    """Finalize rack images with prices and approved try-on images without them."""
    review = read_json(review_path)
    pricing = read_json(pricing_path)
    results: list[dict[str, Any]] = []
    for approval in review.get("approvals", []):
        status = approval.get("status")
        base = {
            "sku": approval.get("sku"),
            "view": approval.get("view"),
            "mode": approval.get("mode", "rack"),
            "status": status,
        }
        finalization = approval.get("finalization", "price_badge")
        expected_status = (
            "APPROVED_FOR_PUBLISH"
            if finalization == "publish_copy"
            else "APPROVED_FOR_PRICE"
        )
        if status != expected_status:
            results.append({**base, "finalized": False, "reason": "QA_NOT_APPROVED"})
            continue
        input_path = resolve_from_root(project_root, approval["input"])
        output_path = resolve_from_root(project_root, approval["output"])
        if not input_path.exists():
            results.append({**base, "finalized": False, "reason": "INPUT_NOT_FOUND", "input": str(input_path)})
            continue
        if finalization == "publish_copy":
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(input_path) as image:
                ImageOps.exif_transpose(image).convert("RGB").save(
                    output_path, format="JPEG", quality=95
                )
            results.append(
                {
                    **base,
                    "finalized": True,
                    "output": str(output_path),
                    "finalization": finalization,
                }
            )
            continue
        cost = approval.get("cost")
        if cost is None or Decimal(str(cost)) <= 0:
            results.append({**base, "finalized": False, "reason": "COST_NOT_CONFIRMED"})
            continue
        price = calculate_price(cost, pricing)
        upper_box, lower_box = detect_physical_sign_boxes(input_path)
        render_physical_sign_text(
            input_path,
            output_path,
            int(price.sale_price),
            upper_box,
            lower_box,
            approval.get("category", "服装"),
            approval.get("category_en", "Apparel"),
        )
        results.append(
            {
                **base,
                "finalized": True,
                "cost": float(price.cost_price),
                "sale_price": int(price.sale_price),
                "output": str(output_path),
                "upper_box": upper_box,
                "lower_box": lower_box,
            }
        )
    summary = {
        "review": str(review_path),
        "approved": sum(1 for item in results if item["finalized"]),
        "held": sum(1 for item in results if not item["finalized"]),
        "results": results,
    }
    if report_path:
        write_json(report_path, summary)
    return summary


def finalize_batch_command(args: argparse.Namespace) -> None:
    summary = finalize_review(
        args.review,
        args.pricing,
        args.project_root.resolve(),
        args.report,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def prepare_publish_package(
    draft_path: Path,
    finalize_summary_path: Path,
    manifest_path: Path,
    project_root: Path,
) -> dict[str, Any]:
    """Merge deterministic outputs into one auditable upload-ready package."""
    draft = read_json(draft_path)
    summary = read_json(finalize_summary_path)
    manifest = read_json(manifest_path)
    finalized = {
        item.get("view"): item
        for item in summary.get("results", [])
        if item.get("finalized") is True
    }
    required_price_views = ["front", "back"]
    expected_sale_price = draft.get("sale_price")
    price_rendered_views = [
        view
        for view in required_price_views
        if view in finalized
        and finalized[view].get("sale_price") is not None
        and expected_sale_price is not None
        and Decimal(str(finalized[view]["sale_price"]))
        == Decimal(str(expected_sale_price))
    ]
    blockers = [
        blocker
        for blocker in draft.get("blockers", [])
        if blocker not in {
            "FRONT_IMAGE_NOT_APPROVED",
            "BACK_IMAGE_NOT_APPROVED",
            "TRYON_MAIN_IMAGE_NOT_APPROVED",
            "TRYON_DETAIL_IMAGE_NOT_APPROVED",
            "TRYON_BACK_IMAGE_NOT_APPROVED",
        }
    ]
    generated_views = [
        "front", "back", "tryon_main", "tryon_detail", "tryon_back"
    ]
    for view in generated_views:
        if view not in finalized:
            blockers.append(f"{view.upper()}_FINAL_IMAGE_MISSING")
    if expected_sale_price is None or Decimal(str(expected_sale_price)) <= 0:
        blockers.append("SALE_PRICE_NOT_CONFIRMED")
    for view in required_price_views:
        if view not in price_rendered_views:
            blockers.append(f"{view.upper()}_PRICE_SIGN_NOT_RENDERED")

    final_images = {
        view: finalized[view]["output"]
        for view in generated_views
        if view in finalized
    }
    yupoo_images = [item["path"] for item in manifest.get("images", [])]
    upload_images = [
        *(final_images.get(view) for view in generated_views),
        *yupoo_images,
    ]
    upload_images = [
        str(resolve_from_root(project_root, image).resolve())
        for image in upload_images
        if image
    ]
    missing = [image for image in upload_images if not Path(image).exists()]
    if missing:
        blockers.append("UPLOAD_IMAGE_NOT_FOUND")

    return {
        **draft,
        "status": "READY_TO_PUBLISH" if not blockers else "DRAFT_REVIEW",
        "blockers": list(dict.fromkeys(blockers)),
        "final_images": final_images,
        "price_display": {
            "status": (
                "READY"
                if len(price_rendered_views) == len(required_price_views)
                else "BLOCKED"
            ),
            "sale_price": expected_sale_price,
            "required_views": required_price_views,
            "rendered_views": price_rendered_views,
            "rule": "发布货架正反面必须写入已确认销售价；空白价格牌禁止入队。",
        },
        "yupoo_images": yupoo_images,
        "upload_images": upload_images,
        "source_run": summary.get("review"),
    }


def prepare_publish_command(args: argparse.Namespace) -> None:
    package = prepare_publish_package(
        args.draft,
        args.finalize_summary,
        args.manifest,
        args.project_root.resolve(),
    )
    write_json(args.output, package)
    print(json.dumps(package, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="Ingest one album and build reference packs")
    run.add_argument("--album-url", required=True)
    run.add_argument("--output-root", type=Path, default=Path("work/items"))
    run.add_argument("--cached-html", type=Path)
    run.add_argument("--classification", type=Path, required=True)
    run.add_argument("--scenes", type=Path, required=True)
    run.add_argument("--pricing", type=Path, required=True)
    run.add_argument(
        "--publishing", type=Path, default=Path("config/publishing.json")
    )
    run.add_argument("--confirm-cost", action="store_true")
    run.set_defaults(func=run_sample)

    prepare = sub.add_parser(
        "prepare-item",
        help="Build packs/facts for an already-ingested Yupoo item without redownloading originals",
    )
    prepare.add_argument("--manifest", type=Path, required=True)
    prepare.add_argument("--classification", type=Path, required=True)
    prepare.add_argument("--scenes", type=Path, required=True)
    prepare.add_argument("--pricing", type=Path, required=True)
    prepare.add_argument(
        "--publishing", type=Path, default=Path("config/publishing.json")
    )
    prepare.add_argument("--confirm-cost", action="store_true")
    prepare.set_defaults(func=prepare_item_command)

    ingest = sub.add_parser("ingest-album", help="Download one Yupoo album without requiring classification")
    ingest.add_argument("--album-url", required=True)
    ingest.add_argument("--output-root", type=Path, default=Path("work/items"))
    ingest.add_argument("--cached-html", type=Path)
    ingest.add_argument("--cached-image-dir", type=Path)
    ingest.set_defaults(func=ingest_album_command)

    discover = sub.add_parser("discover-album", help="Discover products from Yupoo album URL")
    discover.add_argument("--album-url", required=True)
    discover.add_argument("--from-date", default="2026-03-01")
    discover.add_argument("--to-date", default="9999-12-31")
    discover.add_argument("--max-products", type=int, default=10000)
    discover.add_argument("--cached-html", type=Path)
    discover.add_argument("--cached-product-dir", type=Path)
    discover.set_defaults(func=discover_album_command)

    badge = sub.add_parser("render-price-badge", help="Add deterministic sale-price art")
    badge.add_argument("--input", type=Path, required=True)
    badge.add_argument("--output", type=Path, required=True)
    badge.add_argument("--cost", required=True)
    badge.add_argument("--pricing", type=Path, required=True)
    badge.add_argument(
        "--position",
        choices=["top-left", "top-center", "top-right"],
        default="top-center",
    )
    badge.add_argument(
        "--style",
        choices=["orange-board", "green-tag", "red-board"],
        default="orange-board",
    )
    badge.set_defaults(func=render_badge_command)

    sign = sub.add_parser(
        "render-physical-sign",
        help="Write exact text into a generated physical blank rack sign",
    )
    sign.add_argument("--input", type=Path, required=True)
    sign.add_argument("--output", type=Path, required=True)
    sign.add_argument("--cost", required=True)
    sign.add_argument("--pricing", type=Path, required=True)
    sign.add_argument("--upper-box", help="x1,y1,x2,y2; omit with lower-box for auto detection")
    sign.add_argument("--lower-box", help="x1,y1,x2,y2; omit with upper-box for auto detection")
    sign.add_argument("--category", default="男装")
    sign.add_argument("--category-en", default="Men")
    sign.set_defaults(func=render_physical_sign_command)

    canvas = sub.add_parser(
        "normalize-canvas",
        help="Place a complete image on an exact fixed canvas without cropping",
    )
    canvas.add_argument("--input", type=Path, required=True)
    canvas.add_argument("--output", type=Path, required=True)
    canvas.add_argument("--width", type=int, default=1080)
    canvas.add_argument("--height", type=int, default=1440)
    canvas.set_defaults(func=normalize_canvas_command)

    xhs_cover = sub.add_parser(
        "render-xhs-cover",
        help="Build a priced rack plus front/back try-on four-grid XHS cover",
    )
    xhs_cover.add_argument("--front", type=Path, required=True)
    xhs_cover.add_argument("--back", type=Path, required=True)
    xhs_cover.add_argument("--tryon-front", type=Path, required=True)
    xhs_cover.add_argument("--tryon-back", type=Path, required=True)
    xhs_cover.add_argument("--output", type=Path, required=True)
    xhs_cover.add_argument("--width", type=int, default=1080)
    xhs_cover.add_argument("--height", type=int, default=1440)
    xhs_cover.add_argument("--gap", type=int, default=12)
    xhs_cover.add_argument("--layout", choices=["default", "diagonal", "swap"], default="default",
                           help="Layout: default (rack+tryon), diagonal (tryon+rack diagonal), swap (people top, clothes bottom)")
    xhs_cover.add_argument("--zoom-top", type=float, default=0.0,
                           help="Zoom factor for rack images (0.0-1.0, e.g. 0.3 = top 30%%)")
    xhs_cover.set_defaults(func=render_xhs_cover_command)

    finalize = sub.add_parser(
        "finalize-batch",
        help="Add exact prices only to QA-approved rack images",
    )
    finalize.add_argument("--review", type=Path, required=True)
    finalize.add_argument("--pricing", type=Path, default=Path("config/pricing.json"))
    finalize.add_argument("--project-root", type=Path, default=Path("."))
    finalize.add_argument("--report", type=Path)
    finalize.set_defaults(func=finalize_batch_command)

    publish = sub.add_parser(
        "prepare-publish",
        help="Merge an approved finalize summary with a publishing draft",
    )
    publish.add_argument("--draft", type=Path, required=True)
    publish.add_argument("--finalize-summary", type=Path, required=True)
    publish.add_argument("--manifest", type=Path, required=True)
    publish.add_argument("--output", type=Path, required=True)
    publish.add_argument("--project-root", type=Path, default=Path("."))
    publish.set_defaults(func=prepare_publish_command)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
