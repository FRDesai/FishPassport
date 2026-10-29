#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "HX711.h"

MFRC522 rfid(5, 4);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
HX711 hx;

const int BTN_PINS[4] = {13, 14, 25, 27};
const char* BTN_NAMES[4] = {"LAND", "SALE", "TARE", "NEXT"};
const float CAL_FACTOR = 70549;   // raw units per kg (from the 2 L bottle test)

String lastCard = "-", lastButton = "-";
bool oledOk = false, rfidOk = false, hxOk = false;
float rawFilt = 0, offset = 0;
bool btnDown[4];
uint32_t btnChanged[4];

void zeroScale() {
  if (hx.wait_ready_timeout(1000)) {
    offset = hx.read_average(15);
    rawFilt = offset;
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  Serial.println(oledOk ? "OLED ok" : "OLED NOT FOUND");

  SPI.begin();
  rfid.PCD_Init();
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  rfidOk = (v == 0x91 || v == 0x92 || v == 0x88 || v == 0x12);
  Serial.printf("RC522 version 0x%02X -> %s\n", v, rfidOk ? "ok" : "NOT FOUND");

  hx.begin(32, 33);
  for (int i = 0; i < 4; i++) pinMode(BTN_PINS[i], INPUT_PULLUP);
  delay(500);
  zeroScale();   // scale must be empty at start
}

void loop() {
  if (hx.is_ready()) {
    long r = hx.read();
    rawFilt = rawFilt * 0.8 + r * 0.2;   // smooth out jitter
    hxOk = true;
  }
  float kg = (rawFilt - offset) / CAL_FACTOR;
  if (fabsf(kg) < 0.02) kg = 0;          // hide tiny drift around zero

  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    lastCard = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      if (rfid.uid.uidByte[i] < 0x10) lastCard += "0";
      lastCard += String(rfid.uid.uidByte[i], HEX);
    }
    lastCard.toUpperCase();
    rfid.PICC_HaltA();
    Serial.println("Card: " + lastCard);
  }

  for (int i = 0; i < 4; i++) {
    bool down = digitalRead(BTN_PINS[i]) == LOW;
    if (down != btnDown[i] && millis() - btnChanged[i] > 40) {
      btnDown[i] = down;
      btnChanged[i] = millis();
      if (down) {
        lastButton = BTN_NAMES[i];
        Serial.println(String("Button: ") + lastButton);
        if (i == 2) zeroScale();         // TARE sets the scale back to 0.00 kg
      }
    }
  }

  static uint32_t t = 0;
  if (millis() - t > 250) {
    t = millis();
    if (oledOk) {
      oled.clearDisplay();
      oled.setTextColor(SSD1306_WHITE);
      oled.setTextSize(1);
      oled.setCursor(0, 0);  oled.print("PARTS CHECK");
      oled.setCursor(0, 10); oled.print("RFID: "); oled.print(rfidOk ? "ok" : "missing");
      oled.setCursor(0, 20); oled.print("Card: "); oled.print(lastCard);
      oled.setTextSize(2);
      oled.setCursor(0, 32);
      if (hxOk) { oled.print(kg, 2); oled.print(" kg"); } else oled.print("no HX711");
      oled.setTextSize(1);
      oled.setCursor(0, 54); oled.print("Button: "); oled.print(lastButton);
      oled.display();
    }
  }
}
