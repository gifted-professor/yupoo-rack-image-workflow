import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from product_image_workflow import (
    build_product_facts,
    build_publish_draft,
    build_reference_packs,
    calculate_price,
    detect_physical_sign_boxes,
    extract_sizes_from_title,
    finalize_review,
    ingest_album,
    normalize_canvas,
    parse_album_html,
    parse_album_pictures,
    parse_listing_html,
    prepare_publish_package,
    render_xhs_four_grid_cover,
)


class WorkflowTests(unittest.TestCase):
    def test_ingest_album_writes_picture_dates_and_hashes_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cached_images = root / "cached"
            cached_images.mkdir()
            for index in range(6):
                Image.new("RGB", (100 + index, 120 + index), "black").save(cached_images / f"{index + 1:02d}.png")
            fixture = Path(__file__).parent / "fixtures/yupoo/242408630.html"
            manifest_path = ingest_album(
                "https://x.yupoo.com/photos/adidas666888/albums/242408630",
                root / "items",
                cached_html=fixture,
                cached_image_dir=cached_images,
            )
            first = json.loads(manifest_path.read_text(encoding="utf-8"))
            second_path = ingest_album(
                "https://x.yupoo.com/photos/adidas666888/albums/242408630",
                root / "items",
                cached_html=fixture,
                cached_image_dir=cached_images,
            )
            second = json.loads(second_path.read_text(encoding="utf-8"))
            self.assertEqual(len(first["images"]), 6)
            self.assertEqual(first["images"][0]["visible_date"], "2026-06-17")
            self.assertEqual(len(first["images"][0]["sha256"]), 64)
            self.assertEqual(first["source_revision"], second["source_revision"])
            self.assertEqual(first["images"][0]["sha256"], second["images"][0]["sha256"])

    def test_discover_yupoo_listing_deduplicates_album_links(self):
        fixture = Path(__file__).parent / "fixtures/yupoo/list-page-1.html"
        result = parse_listing_html(
            fixture.read_text(encoding="utf-8"),
            "https://x.yupoo.com/photos/adidas666888/collections/200106",
        )
        self.assertEqual(len(result["albums"]), 3)
        self.assertEqual(result["albums"][0]["album_id"], "242408630")
        self.assertEqual(result["next_page"], "https://x.yupoo.com/photos/adidas666888/collections/200106?page=2")

    def test_discover_yupoo_picture_dates_use_visible_time(self):
        fixture = Path(__file__).parent / "fixtures/yupoo/242408630.html"
        result = parse_album_pictures(
            fixture.read_text(encoding="utf-8"),
            "https://x.yupoo.com/photos/adidas666888/albums/242408630",
        )
        self.assertEqual(result["sku"], "KT7794")
        self.assertEqual(len(result["pictures"]), 6)
        self.assertEqual(result["picture_dates"], ["2026-06-17"])
        self.assertEqual(result["pictures"][0]["filename"], "ScreenShot_2026-06-16_a.png")
        self.assertEqual(result["pictures"][0]["visible_date"], "2026-06-17")

    def test_xhs_four_grid_cover_keeps_complete_priced_and_tryon_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            colors = ["red", "green", "blue", "yellow"]
            inputs = []
            for index, color in enumerate(colors):
                source = root / f"source-{index}.png"
                image = Image.new("RGB", (300, 600), color)
                draw = ImageDraw.Draw(image)
                draw.rectangle((0, 0, 299, 29), fill="white")
                draw.rectangle((0, 570, 299, 599), fill="black")
                image.save(source)
                inputs.append(source)
            output = root / "cover.jpg"
            result = render_xhs_four_grid_cover(*inputs, output, 1080, 1440, 12)
            with Image.open(output) as cover:
                self.assertEqual(cover.size, (1080, 1440))
                self.assertGreater(sum(cover.getpixel((264, 1))), 700)
                self.assertLess(sum(cover.getpixel((264, 713))), 80)
                self.assertGreater(sum(cover.getpixel((816, 1))), 700)
                self.assertLess(sum(cover.getpixel((816, 713))), 80)
            self.assertEqual(result["tile_size"], [534, 714])
            self.assertEqual(
                result["layout"],
                ["priced_front", "priced_back", "tryon_front", "tryon_back"],
            )

    def test_normalize_canvas_is_exact_three_by_four_without_cropping(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "portrait.png"
            output = root / "fixed.png"
            image = Image.new("RGB", (600, 1200), "red")
            draw = ImageDraw.Draw(image)
            draw.rectangle((0, 0, 599, 99), fill="green")
            draw.rectangle((0, 1100, 599, 1199), fill="blue")
            image.save(source)
            result = normalize_canvas(source, output, 1080, 1440)
            with Image.open(output) as fixed:
                self.assertEqual(fixed.size, (1080, 1440))
                self.assertEqual(fixed.getpixel((540, 1)), (0, 128, 0))
                self.assertEqual(fixed.getpixel((540, 1438)), (0, 0, 255))
            self.assertEqual(result["input_size"], [600, 1200])
            self.assertEqual(result["output_size"], [1080, 1440])

    def test_extract_sizes_from_yupoo_title(self):
        self.assertEqual(
            extract_sizes_from_title("新款IX1577-274 男款短袖T恤 S-XXL 65"),
            ["S", "M", "L", "XL", "XXL"],
        )

    def test_product_facts_create_safe_publish_draft(self):
        manifest = {
            "sku": "IX1577-274",
            "album_url": "https://example.yupoo.com/albums/1",
            "title": "IX1577-274 男款短袖 60",
        }
        classification = {
            "brand": "jordan",
            "product_type": "shirt",
            "review_state": "manual_verified",
            "facts": {
                "brand_display": "Jordan耐克",
                "gender": ["男子"],
                "product_line": ["AJ1经典系列"],
                "category": "短袖T恤",
                "materials": ["中磅纯棉"],
                "features": [],
                "use_cases": ["日常休闲"],
                "sizes": ["S", "M", "L"],
                "colors": ["马毛棕"],
            },
        }
        pricing = {"status": "READY", "cost_price": 60, "sale_price": 109}
        facts = build_product_facts(manifest, classification, pricing)
        draft = build_publish_draft(facts, {
            "defaults": {
                "inventory_per_variant": 10,
                "shipping_template_name": "全国统一运费 10 元",
                "shipping_fee": 10,
            },
            "existing_tags": ["当月新品", "✔Nike", "👕短袖"],
            "brand_tags": {"jordan": "✔Nike"},
            "category_tags": {"短袖": "👕短袖"},
        })
        self.assertEqual(facts["status"], "VERIFIED")
        self.assertEqual(facts["style_code"], "IX1577")
        self.assertEqual(
            draft["title"],
            "Jordan耐克男子AJ1经典系列中磅纯棉日常休闲短袖T恤IX1577",
        )
        self.assertNotIn("2026秋款", draft["title"])
        self.assertNotIn("COST_NOT_CONFIRMED", draft["blockers"])
        self.assertEqual(draft["status"], "DRAFT_REVIEW")
        self.assertEqual(draft["final_action"], "HUMAN_CONFIRM_REQUIRED")
        self.assertEqual(draft["inventory_per_variant"], 10)
        self.assertEqual(draft["shipping"]["fee"], 10)
        self.assertEqual(len(draft["variants"]), 3)
        self.assertEqual(draft["tags"], ["✔Nike", "👕短袖"])
        self.assertEqual(draft["image_order"][:4], [
            "front_rack", "back_rack", "tryon_main", "tryon_detail"
        ])
        self.assertIn("TRYON_MAIN_IMAGE_NOT_APPROVED", draft["blockers"])

    def test_publish_draft_blocks_unverified_facts_and_cost(self):
        facts = build_product_facts(
            {"sku": "IF2164-010", "album_url": "x", "title": "x"},
            {"brand": "nike", "product_type": "jacket", "facts": {}},
            {"status": "BLOCKED_UNCONFIRMED_COST"},
        )
        draft = build_publish_draft(facts)
        self.assertIn("FACTS_NOT_MANUALLY_VERIFIED", draft["blockers"])
        self.assertIn("CATEGORY_NOT_CONFIRMED", draft["blockers"])
        self.assertIn("COST_NOT_CONFIRMED", draft["blockers"])
        self.assertIsNone(draft["sale_price"])
        self.assertNotIn(None, draft["tags"])
        self.assertEqual(draft["variants"], [])

    def test_publish_draft_does_not_invent_null_color_variants(self):
        facts = build_product_facts(
            {
                "sku": "FN2999-251",
                "album_url": "x",
                "title": "新款FN2999-251 男款短裤 S-XXL 70",
            },
            {
                "brand": "nike",
                "product_type": "shorts",
                "review_state": "manual_verified",
                "facts": {"category": "男装短裤", "colors": []},
            },
            {"status": "READY", "cost_price": 70, "sale_price": 119},
        )
        draft = build_publish_draft(facts)
        self.assertEqual(draft["sizes"], ["S", "M", "L", "XL", "XXL"])
        self.assertEqual(draft["colors"], [])
        self.assertEqual(draft["variants"], [])
        self.assertIn("COLORS_NOT_CONFIRMED", draft["blockers"])

    def test_model_worn_front_and_back_are_usable_for_rack_generation(self):
        facts = build_product_facts(
            {
                "sku": "IX1577-274",
                "album_url": "x",
                "title": "新款IX1577-274 男款短袖T恤 S-XXL 65",
            },
            {
                "brand": "jordan",
                "product_type": "shirt",
                "review_state": "manual_verified",
                "reference_image_status": "usable_model_worn",
                "facts": {"category": "短袖T恤", "colors": ["马毛棕"]},
            },
            {"status": "READY", "cost_price": 65, "sale_price": 109},
        )
        draft = build_publish_draft(facts)
        self.assertEqual(facts["sizes"], ["S", "M", "L", "XL", "XXL"])
        self.assertNotIn("SKIP_UNUSABLE_REFERENCES", draft["blockers"])
        self.assertEqual(len(draft["variants"]), 5)

    def test_unusable_references_still_block_rack_generation(self):
        facts = build_product_facts(
            {"sku": "AB1234-001", "album_url": "x", "title": "AB1234-001"},
            {
                "brand": "nike",
                "product_type": "shirt",
                "reference_image_status": "unusable",
                "facts": {"category": "短袖T恤"},
            },
            {"status": "BLOCKED_UNCONFIRMED_COST"},
        )
        draft = build_publish_draft(facts)
        self.assertIn("SKIP_UNUSABLE_REFERENCES", draft["blockers"])

    def test_parse_yupoo_album(self):
        html = '''
        <title>新款 IF2164-010 男款防晒衣 S-XXL 135 | 相册 | 店铺</title>
        <img data-origin-src="https://photo.yupoo.com/u/hash/a.png">
        <img data-origin-src="https://photo.yupoo.com/u/hash/b.png">
        '''
        result = parse_album_html(html, "https://x.yupoo.com/photos/u/albums/1")
        self.assertEqual(result["sku"], "IF2164-010")
        self.assertEqual(result["candidate_cost_price"], 135.0)
        self.assertFalse(result["candidate_cost_confirmed"])
        self.assertEqual(len(result["image_urls"]), 2)

    def test_parse_sku_without_space_after_chinese_text(self):
        html = '''
        <title>新款IF2083-100 男款短袖 S-XXL 55 | 相册 | 店铺</title>
        <img data-origin-src="https://photo.yupoo.com/u/hash/a.png">
        '''
        result = parse_album_html(html, "https://x.yupoo.com/photos/u/albums/2")
        self.assertEqual(result["sku"], "IF2083-100")
        self.assertEqual(result["candidate_cost_price"], 55.0)

    def test_pricing_example(self):
        rules = {
            "cost_multiplier": 2.0,
            "fixed_markup": 0,
            "round_step": 10,
            "price_ending": 9,
            "target_discount": 0.7,
        }
        result = calculate_price(135, rules)
        self.assertEqual(float(result.sale_price), 269.0)
        self.assertEqual(float(result.list_price), 389.0)
        self.assertEqual(float(result.discount), 6.9)

    def test_production_cost_ratio_rounds_up(self):
        rules = {
            "cost_ratio_target": 0.6,
            "fixed_markup": 0,
            "round_step": 10,
            "price_ending": 9,
        }
        result = calculate_price(135, rules)
        self.assertEqual(float(result.sale_price), 229.0)
        self.assertLessEqual(135 / float(result.sale_price), 0.6)
        self.assertGreater(135 / 219, 0.6)
        self.assertIsNone(result.list_price)
        self.assertIsNone(result.discount)

    def test_production_cost_ratio_exact_step_still_rounds_up(self):
        rules = {
            "cost_ratio_target": 0.6,
            "fixed_markup": 0,
            "round_step": 10,
            "price_ending": 9,
        }
        result = calculate_price(60, rules)
        self.assertEqual(float(result.sale_price), 109.0)
        self.assertLessEqual(60 / float(result.sale_price), 0.6)

    def test_production_price_for_validated_jacket_sample(self):
        rules = {
            "cost_ratio_target": 0.6,
            "fixed_markup": 0,
            "round_step": 10,
            "price_ending": 9,
        }
        result = calculate_price(170, rules)
        self.assertEqual(float(result.sale_price), 289.0)
        self.assertLessEqual(170 / float(result.sale_price), 0.6)

    def test_auto_detect_physical_sign_boxes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sign.png"
            image = Image.new("RGB", (1080, 1440), "#777777")
            draw = ImageDraw.Draw(image)
            draw.rectangle((340, 40, 740, 200), fill="#ef552d")
            draw.rectangle((340, 214, 740, 294), fill="#202020")
            image.save(path)
            upper, lower = detect_physical_sign_boxes(path)
            self.assertLessEqual(abs(upper[0] - 340), 5)
            self.assertLessEqual(abs(upper[1] - 40), 5)
            self.assertLessEqual(abs(upper[2] - 741), 6)
            self.assertLessEqual(abs(upper[3] - 201), 6)
            self.assertEqual(lower[1], 214)
            self.assertEqual(lower[3], 295)

    def test_reference_limit_and_back_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = {
                "sku": "IF2164-010",
                "images": [
                    {"index": i, "path": f"/tmp/{i}.png"}
                    for i in range(1, 7)
                ],
            }
            classification = {
                "brand": "nike",
                "roles": {
                    "front_full": [1], "back_full": [2], "logo_detail": [4],
                    "front_structure_detail": [3, 5], "back_structure_detail": [],
                    "shared_structure_detail": [3, 6], "collar_detail": [3],
                    "hem_pocket_detail": [5], "sleeve_detail": [6],
                    "fabric_detail": [], "tag_detail": []
                },
            }
            scenes = {"sign_reference": "/scene/sign.png", "scenes": [
                {"brand": "nike", "path": "/scene/front1.png", "tags": ["front"]},
                {"brand": "nike", "path": "/scene/front2.png", "tags": ["front"]},
                {"brand": "nike", "path": "/scene/back.png", "tags": ["back"]},
            ]}
            for name, data in (("manifest.json", manifest), ("classification.json", classification), ("scenes.json", scenes)):
                (root / name).write_text(json.dumps(data), encoding="utf-8")
            result = build_reference_packs(
                root / "manifest.json", root / "classification.json", root / "scenes.json", root / "packs.json"
            )
            self.assertEqual(result["front"]["status"], "READY")
            self.assertEqual(len(result["front"]["scene_references"]) + len(result["front"]["product_references"]), 4)
            self.assertEqual(result["sign_reference"], "/scene/sign.png")
            self.assertEqual(result["back"]["status"], "BLOCKED_NO_BACK_DETAILS")

    def test_finalize_requires_explicit_qa_approval(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "blank-sign.png"
            image = Image.new("RGB", (1080, 1440), "#777777")
            draw = ImageDraw.Draw(image)
            draw.rectangle((340, 40, 740, 200), fill="#ef552d")
            draw.rectangle((340, 214, 740, 294), fill="#202020")
            image.save(source)
            pricing = root / "pricing.json"
            pricing.write_text(json.dumps({
                "cost_ratio_target": 0.6,
                "fixed_markup": 0,
                "round_step": 10,
                "price_ending": 9,
            }), encoding="utf-8")
            review = root / "review.json"
            review.write_text(json.dumps({"approvals": [
                {
                    "sku": "HM9699-897", "view": "front",
                    "status": "APPROVED_FOR_PRICE", "input": "blank-sign.png",
                    "output": "approved.jpg", "cost": 60,
                    "category": "女装", "category_en": "Women",
                },
                {
                    "sku": "HM9699-897", "view": "back",
                    "status": "REPAIR_REQUIRED", "input": "blank-sign.png",
                    "output": "held.jpg", "cost": 60,
                    "category": "女装", "category_en": "Women",
                },
            ]}), encoding="utf-8")
            result = finalize_review(review, pricing, root)
            self.assertEqual(result["approved"], 1)
            self.assertEqual(result["held"], 1)
            self.assertTrue((root / "approved.jpg").exists())
            self.assertFalse((root / "held.jpg").exists())
            self.assertEqual(result["results"][0]["sale_price"], 109)

    def test_finalize_copies_tryon_without_price_badge(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "tryon.png"
            output = root / "tryon.jpg"
            Image.new("RGB", (20, 30), "blue").save(source)
            pricing = root / "pricing.json"
            pricing.write_text(json.dumps({
                "cost_ratio_target": 0.6,
                "fixed_markup": 0,
                "round_step": 10,
                "price_ending": 9,
            }), encoding="utf-8")
            review = root / "review.json"
            review.write_text(json.dumps({"approvals": [{
                "sku": "IX1577-274",
                "view": "tryon_main",
                "mode": "tryon",
                "status": "APPROVED_FOR_PUBLISH",
                "finalization": "publish_copy",
                "input": str(source),
                "output": str(output),
            }]}), encoding="utf-8")
            result = finalize_review(review, pricing, root)
            self.assertEqual(result["approved"], 1)
            self.assertTrue(output.exists())
            self.assertEqual(result["results"][0]["finalization"], "publish_copy")
            self.assertNotIn("sale_price", result["results"][0])

    def test_prepare_publish_requires_all_five_generated_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            front = root / "front.jpg"
            back = root / "back.jpg"
            yupoo = root / "original.png"
            tryon_main = root / "tryon-main.jpg"
            tryon_detail = root / "tryon-detail.jpg"
            tryon_back = root / "tryon-back.jpg"
            for path in (front, back, tryon_main, tryon_detail, tryon_back, yupoo):
                Image.new("RGB", (10, 10), "white").save(path)
            draft = root / "draft.json"
            draft.write_text(json.dumps({
                "status": "DRAFT_REVIEW",
                "sale_price": 109,
                "blockers": [
                    "FRONT_IMAGE_NOT_APPROVED", "BACK_IMAGE_NOT_APPROVED",
                    "TRYON_MAIN_IMAGE_NOT_APPROVED", "TRYON_DETAIL_IMAGE_NOT_APPROVED",
                ],
                "sku": "IX1577-274",
                "image_order": [
                    "front_rack", "back_rack", "tryon_main", "tryon_detail",
                    "tryon_back",
                    "yupoo_front", "yupoo_back", "yupoo_details",
                ],
            }), encoding="utf-8")
            summary = root / "summary.json"
            summary.write_text(json.dumps({
                "review": "review.json",
                "results": [
                    {"view": "front", "finalized": True, "output": str(front), "sale_price": 109},
                    {"view": "back", "finalized": True, "output": str(back), "sale_price": 109},
                    {"view": "tryon_main", "finalized": True, "output": str(tryon_main)},
                    {"view": "tryon_detail", "finalized": True, "output": str(tryon_detail)},
                    {"view": "tryon_back", "finalized": True, "output": str(tryon_back)},
                ],
            }), encoding="utf-8")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({
                "images": [{"path": str(yupoo)}],
            }), encoding="utf-8")
            package = prepare_publish_package(draft, summary, manifest, root)
            self.assertEqual(package["status"], "READY_TO_PUBLISH")
            self.assertEqual(package["blockers"], [])
            self.assertEqual(package["price_display"]["status"], "READY")
            self.assertEqual(package["price_display"]["rendered_views"], ["front", "back"])
            self.assertEqual(package["upload_images"], [
                str(front.resolve()), str(back.resolve()),
                str(tryon_main.resolve()), str(tryon_detail.resolve()),
                str(tryon_back.resolve()),
                str(yupoo.resolve())
            ])

    def test_prepare_publish_blocks_blank_price_signs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            front = root / "front.jpg"
            back = root / "back.jpg"
            yupoo = root / "original.png"
            for path in (front, back, yupoo):
                Image.new("RGB", (10, 10), "white").save(path)
            draft = root / "draft.json"
            draft.write_text(json.dumps({
                "status": "DRAFT_REVIEW",
                "blockers": ["FRONT_IMAGE_NOT_APPROVED", "BACK_IMAGE_NOT_APPROVED"],
                "sku": "PRICE-GATE",
                "sale_price": 119,
                "image_order": ["front_rack", "back_rack", "tryon_main", "tryon_detail", "tryon_back", "yupoo_front"],
            }), encoding="utf-8")
            summary = root / "summary.json"
            summary.write_text(json.dumps({
                "review": "review.json",
                "results": [
                    {"view": "front", "finalized": True, "output": str(front)},
                    {"view": "back", "finalized": True, "output": str(back)},
                ],
            }), encoding="utf-8")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"images": [{"path": str(yupoo)}]}), encoding="utf-8")
            package = prepare_publish_package(draft, summary, manifest, root)
            self.assertEqual(package["status"], "DRAFT_REVIEW")
            self.assertIn("FRONT_PRICE_SIGN_NOT_RENDERED", package["blockers"])
            self.assertIn("BACK_PRICE_SIGN_NOT_RENDERED", package["blockers"])
            self.assertEqual(package["price_display"]["status"], "BLOCKED")


if __name__ == "__main__":
    unittest.main()
