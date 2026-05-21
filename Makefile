# HiveHive top-level make targets.
#
# These wrap the per-service test runners so that a contributor can verify
# the full repo with one command. Each target prints what it actually shells
# out to, so it is always discoverable how to run the same step by hand.

.PHONY: help firmware test test-esp test-esp-native test-e2e test-e2e-deps test-ui test-ui-deps check-citations check-stale-reset-prose check-stale-display-name-rule check-no-hardcoded-api-keys

help:
	@echo "HiveHive — available make targets"
	@echo ""
	@echo "  make firmware           Build ESP32-CAM firmware and stage homepage/public/firmware.bin"
	@echo "  make test               Run every test suite that can run on this host"
	@echo "  make test-esp           Run ESP32-CAM unit tests on host (no hardware)"
	@echo "  make test-esp-native    Alias for test-esp"
	@echo "  make test-e2e           Run end-to-end pipeline test (boots docker compose)"
	@echo "  make test-e2e-deps      Install Python deps for the e2e test"
	@echo "  make test-ui            Run UI tests in real Chromium (boots docker compose + homepage)"
	@echo "  make test-ui-deps       Install Node + Playwright + Chromium for the UI tests"
	@echo "  make check-citations    Verify path:line citations in docs/ + CLAUDE.md still resolve"
	@echo "  make check-stale-reset-prose"
	@echo "                          Catch broken pre-#40 'hold IO0 for N seconds' factory-reset prose"
	@echo "  make check-stale-display-name-rule"
	@echo "                          Catch the deprecated 'displayName ?? name' rule re-emerging outside its allow-list (PR 1)"
	@echo "  make check-no-hardcoded-api-keys"
	@echo "                          Catch a hardcoded Google API key literal in source (issue #18)"
	@echo ""
	@echo "Prerequisites:"
	@echo "  firmware    →   arduino-cli with esp32:esp32 core installed"
	@echo "  test-esp*   →   pip install platformio   (provides 'pio')"
	@echo "  test-e2e    →   docker + docker compose v2"
	@echo "                  pip install -r tests/e2e/requirements.txt"
	@echo "  test-ui     →   docker + docker compose v2, node 22, python 3.11"
	@echo "                  (cd tests/ui && npm ci && npx playwright install --with-deps chromium)"
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

# UI tests in real Chromium against the production-built homepage.
# UI_REUSE_STACK=1 skips boot/teardown - mirrors E2E_REUSE_STACK in
# tests/e2e/conftest.py. The test-e2e umbrella target deliberately
# does not pull this in yet (chapter 11 lesson: let a new gate stack
# a few green CI runs before adding it to `make test`).
test-ui-deps:
	@echo ">>> cd tests/ui && npm ci && npx playwright install --with-deps chromium"
	cd tests/ui && npm ci && npx playwright install --with-deps chromium

# Single-recipe to avoid `ifeq`-vs-recipe parsing edge cases. The shell
# `if` keeps everything in one process so trap cleanup runs even on
# spec failure.
test-ui:
	@echo ">>> tests/ui Playwright run (boots compose, seeds, runs, tears down)"
	@set -e; \
	if [ "$$UI_REUSE_STACK" = "1" ]; then \
	  echo ">>> UI_REUSE_STACK=1: reusing existing stack"; \
	  python tests/ui/scripts/seed_ui_fixtures.py; \
	  cd tests/ui && npx playwright test; \
	else \
	  docker compose -f tests/ui/docker-compose.ui.yml -p highfive-ui up -d --build; \
	  trap 'docker compose -f tests/ui/docker-compose.ui.yml -p highfive-ui logs --no-color; docker compose -f tests/ui/docker-compose.ui.yml -p highfive-ui down -v' EXIT; \
	  python tests/ui/scripts/seed_ui_fixtures.py; \
	  ( cd tests/ui && npx playwright test ); \
	  trap - EXIT; \
	  docker compose -f tests/ui/docker-compose.ui.yml -p highfive-ui down -v; \
	fi

check-citations:
	@echo ">>> bash scripts/check-doc-citations.sh"
	@bash scripts/check-doc-citations.sh

check-stale-reset-prose:
	@echo ">>> bash scripts/check-stale-reset-prose.sh"
	@bash scripts/check-stale-reset-prose.sh

check-stale-display-name-rule:
	@echo ">>> bash scripts/check-stale-display-name-rule.sh"
	@bash scripts/check-stale-display-name-rule.sh

check-no-hardcoded-api-keys:
	@echo ">>> bash scripts/check-no-hardcoded-api-keys.sh"
	@bash scripts/check-no-hardcoded-api-keys.sh
