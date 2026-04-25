# HiveHive top-level make targets.
#
# These wrap the per-service test runners so that a contributor can verify
# the full repo with one command. Each target prints what it actually shells
# out to, so it is always discoverable how to run the same step by hand.

.PHONY: help test test-esp test-esp-native

help:
	@echo "HiveHive — available make targets"
	@echo ""
	@echo "  make test               Run every test suite that can run on this host"
	@echo "  make test-esp           Run ESP32-CAM unit tests on host (no hardware)"
	@echo "  make test-esp-native    Alias for test-esp"
	@echo ""
	@echo "Prerequisites:"
	@echo "  test-esp*   →   pip install platformio   (provides 'pio')"
	@echo ""

test: test-esp-native

test-esp: test-esp-native

test-esp-native:
	@echo ">>> python -m platformio test -e native (ESP32-CAM/)"
	cd ESP32-CAM && python -m platformio test -e native
