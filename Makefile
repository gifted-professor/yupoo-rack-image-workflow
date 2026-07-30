.PHONY: test preflight

test:
	sh scripts/test-python.sh

preflight:
	node scripts/generate-racks.mjs --batch config/batch.example.json --dry-run
