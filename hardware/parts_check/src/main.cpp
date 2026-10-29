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

const int BTN_PINS[4] = {13, 14, 26, 27};
const char* BTN_NAMES[4] = {"LAND", "SALE", "TARE", "NEXT"};

String lastCard = "-", lastButton = "-";
long raw = 0;
bool oledOk = false, rfidOk = false, hxOk = false;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  Serial.println(oledOk ? "OLED ok" : "OLED NOT FOUND - check SDA/SCL, try address 0x3D");

  SPI.begin();
  rfid.PCD_Init();
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  rfidOk = (v == 0x91 || v == 0x92 || v == 0x88 || v == 0x12);
  Serial.printf("RC522 version 0x%02X -> %s\n", v, rfidOk ? "ok" : "NOT FOUND - check wiring");

  hx.begin(32, 33);
  for (int i = 0; i < 4; i++) pinMode(BTN_PINS[i], INPUT_PULLUP);
}

void loop() {
  if (hx.is_ready()) { raw = hx.read(); hxOk = true; }

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
    if (digitalRead(BTN_PINS[i]) == LOW && lastButton != BTN_NAMES[i]) {
      lastButton = BTN_NAMES[i];
      Serial.println(String("Button: ") + lastButton);
    }
  }

  static uint32_t t = 0;
  if (millis() - t > 250) {
    t = millis();
    if (!hxOk) Serial.println("HX711 not answering - check DT/SCK/VCC");
    if (oledOk) {
      oled.clearDisplay();
      oled.setTextColor(SSD1306_WHITE);
      oled.setTextSize(1);
      oled.setCursor(0, 0);  oled.print("PARTS CHECK");
      oled.setCursor(0, 14); oled.print("RFID: "); oled.print(rfidOk ? "ok" : "missing");
      oled.setCursor(0, 24); oled.print("Card: "); oled.print(lastCard);
      oled.setCursor(0, 34); oled.print("Load: "); oled.print(hxOk ? String(raw) : String("no HX711"));
      oled.setCursor(0, 44); oled.print("Button: "); oled.print(lastButton);
      oled.display();
    }
  }
}
