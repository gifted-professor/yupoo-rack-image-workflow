#!/usr/bin/env python3
"""Evidence audit for the March-to-present Yupoo full run."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from PIL import Image


VIEWS = ("front", "back", "tryon_main", "tryon_detail", "tryon_back")


def read_json(path: Path, fallback: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def latest_view(runs_root: Path, sku: str, view: str) -> tuple[Path, Path] | None:
    candidates = []
    for suffix in ("png", "jpg", "jpeg", "webp"):
        candidates.extend(runs_root.glob(f"*/review/{sku}-{view}.{suffix}"))
    if not candidates:
        return None
    image = max(candidates, key=lambda item: item.stat().st_mtime_ns)
    response = image.parent.parent / "responses" / f"{sku}-{view}.json"
    return image, response


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", default="runs/full-20260722/discovery.json")
    parser.add_argument("--report", default="runs/full-20260722/final-audit.json")
    args = parser.parse_args()

    root = Path(".")
    snapshot = read_json(root / args.snapshot, {})
    products = [item for item in snapshot.get("products", []) if item.get("included")]
    issues: list[dict[str, Any]] = []
    rows = []
    legacy_sidecars = 0

    for product in products:
        sku = product["sku"]
        item_root = root / "work" / "items" / sku
        manifest = read_json(item_root / "manifest.json", {})
        original_issues = []
        for image in manifest.get("images", []):
            path = Path(image.get("path", ""))
            if not path.is_absolute():
                path = root / path
            if not path.exists():
                original_issues.append(f"missing original: {image.get('path')}")
            elif not image.get("sha256"):
                original_issues.append(f"missing sha256: {image.get('path')}")
        if original_issues:
            issues.append({"sku": sku, "stage": "originals", "details": original_issues})

        latest = {}
        for view in VIEWS:
            found = latest_view(root / "runs", sku, view)
            if not found:
                issues.append({"sku": sku, "stage": "generation", "view": view, "error": "missing view"})
                continue
            image, response = found
            latest[view] = image.relative_to(root).as_posix()
            try:
                with Image.open(image) as opened:
                    if opened.size != (1080, 1440):
                        issues.append({"sku": sku, "stage": "generation", "view": view, "error": f"wrong canvas {opened.size}"})
                    opened.verify()
            except Exception as error:  # pragma: no cover - defensive audit path
                issues.append({"sku": sku, "stage": "generation", "view": view, "error": f"unreadable: {error}"})
            if not response.exists():
                issues.append({"sku": sku, "stage": "generation", "view": view, "error": "missing response sidecar"})
            else:
                response_value = read_json(response, {})
                if response_value.get("legacy"):
                    legacy_sidecars += 1

        classification = root / "config" / f"{sku}.classification.json"
        if not classification.exists():
            issues.append({"sku": sku, "stage": "classification", "error": "missing classification"})

        price_manifest_path = item_root / "price-previews" / "manifest.json"
        price_manifest = read_json(price_manifest_path, {})
        price_issues = []
        for view in ("front", "back"):
            entry = price_manifest.get("views", {}).get(view, {})
            output = root / entry.get("output", "")
            if not output.exists():
                price_issues.append(f"missing {view} preview")
            if latest.get(view) and entry.get("source") != latest[view]:
                price_issues.append(f"{view} source is stale")
        if price_manifest.get("status") != "READY" or price_issues:
            issues.append({"sku": sku, "stage": "price_previews", "details": price_issues or ["not READY"]})

        cover_manifest_path = item_root / "xhs-cover" / "manifest.json"
        cover_manifest = read_json(cover_manifest_path, {})
        cover_path = root / "work" / "items" / sku / "xhs-cover" / "four-grid.jpg"
        cover_issues = []
        if not cover_path.exists():
            cover_issues.append("missing four-grid.jpg")
        else:
            try:
                with Image.open(cover_path) as opened:
                    if opened.size != (1080, 1440):
                        cover_issues.append(f"wrong canvas {opened.size}")
                    opened.verify()
            except Exception as error:  # pragma: no cover - defensive audit path
                cover_issues.append(f"unreadable: {error}")
        if cover_manifest.get("canvas") != {"width": 1080, "height": 1440}:
            cover_issues.append("manifest canvas is not 1080x1440")
        sources = cover_manifest.get("sources", {})
        if latest.get("tryon_main") and sources.get("tryon_front") != latest["tryon_main"]:
            cover_issues.append("tryon_front source is stale")
        if latest.get("tryon_back") and sources.get("tryon_back") != latest["tryon_back"]:
            cover_issues.append("tryon_back source is stale")
        for source_name, price_view in (("front", "front"), ("back", "back")):
            expected_price = price_manifest.get("views", {}).get(price_view, {}).get("output")
            if expected_price and sources.get(source_name) != expected_price:
                cover_issues.append(f"{source_name} price source is stale")
        if cover_issues:
            issues.append({"sku": sku, "stage": "cover", "details": cover_issues})

        approval_root = root / "work" / "approval-signals"
        approval_signals = list(approval_root.glob(f"*{sku}*.json")) if approval_root.exists() else []
        if approval_signals:
            issues.append({"sku": sku, "stage": "approval", "error": "approval signal exists; audit expects manual gate"})
        rows.append({"sku": sku, "latest_views": len(latest), "cover": not cover_issues, "price_previews": not price_issues and price_manifest.get("status") == "READY"})

    report = {
        "version": 1,
        "snapshot": args.snapshot,
        "target_count": len(products),
        "complete_products": sum(row["latest_views"] == len(VIEWS) and row["cover"] and row["price_previews"] for row in rows),
        "legacy_response_sidecars": legacy_sidecars,
        "issues": issues,
        "ok": not issues and len(products) == 89,
    }
    report_path = root / args.report
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
