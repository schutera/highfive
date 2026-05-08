# HiveHive top-level make targets.
#
# These wrap the per-service test runners so that a contributor can verify
# the full repo with one command. Each target prints what it actually shells
# out to, so it is always discoverable how to run the same step by hand.

.PHONY: help firmware test test-esp test-esp-native test-e2e test-e2e-deps check-citations

help:
	@echo "HiveHive — available make targets"
	@echo ""
	@echo "  make firmware           Build ESP32-CAM firmware and stage homepage/public/firmware.bin"
	@echo "  make test               Run every test suite that can run on this host"
	@echo "  make test-esp           Run ESP32-CAM unit tests on host (no hardware)"
	@echo "  make test-esp-native    Alias for test-esp"
	@echo "  make test-e2e           Run end-to-end pipeline test (boots docker compose)"
	@echo "  make test-e2e-deps      Install Python deps for the e2e test"
	@echo "  make check-citations    Verify path:line citations in docs/ + CLAUDE.md still resolve"
	@echo ""
	@echo "Prerequisites:"
	@echo "  firmware    →   arduino-cli with esp32:esp32 core installed"
	@echo "  test-esp*   →   pip install platformio   (provides 'pio')"
	@echo "  test-e2e    →   docker + docker compose v2"
	@echo "                  pip install -r tests/e2e/requirements.txt"
	@echo ""

# Wraps ESP32-CAM/build.sh: arduino-cli compile → merged.bin →
# homepage/public/{firmware.bin,firmware.json}. The setup wizard's Step 2
# fetches /firmware.bin from the homepage container; without this step,
# Vite's SPA fallback returns index.html and the wizard rejects the
# response (issue #43).
firmware:
	@echo ">>> ESP32-CAM/build.sh"
	cd ESP32-CAM && ./build.sh

test: test-esp-native test-e2e

test-esp: test-esp-native

test-esp-native:
	@echo ">>> python -m platformio test -e native (ESP32-CAM/)"
	cd ESP32-CAM && python -m platformio test -e native

test-e2e-deps:
	@echo ">>> pip install -r tests/e2e/requirements.txt"
	pip install -r tests/e2e/requirements.txt

test-e2e:
	@echo ">>> pytest tests/e2e/ -v"
	python -m pytest tests/e2e/ -v

check-citations:
	@echo ">>> bash scripts/check-doc-citations.sh"
	@bash scripts/check-doc-citations.sh
