/*
    ESP32-CAM Hello World Example
    - Initializes serial communication at 115200 baud
    - Prints a greeting message to the serial monitor
    - Intended as a basic test for ESP32-CAM board setup
    - No additional functionality in the main loop

    Hints for beginners: Make sure to set baud to 115200 in your serial monitor to see the output.
    If you see "Hello from ESP32-CAM!" in the serial monitor, your setup is working correctly.
    If you don't see the message, press the reset / RST button on the ESP32-CAM board to restart it.
    Ensure you have the correct board selected in your Arduino IDE (ESP32 Wrover Module or similar).
    You can make it.
*/

void setup() {
  Serial.begin(115200);
  Serial.println("Hello from ESP32-CAM!");
}

void loop() {
  // Do nothing
}
