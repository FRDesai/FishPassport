
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Preferences.h>
#include <time.h>
#include "HX711.h"
#include "mbedtls/md.h"
#include "config.h"

const float STABLE_BAND_KG = 0.02;
const float MIN_NET_KG     = 0.05;
const long  TZ_OFFSET_S    = 19800;

#define PIN_SDA      21
#define PIN_SCL      22
#define PIN_RFID_SS   5
#define PIN_RFID_RST  4
#define PIN_HX_DT    32
#define PIN_HX_SCK   33
#define OLED_ADDR  0x3C

enum Btn { B_LAND, B_SALE, B_TARE, B_NEXT, B_COUNT };
enum Mode { IDLE, LAND_FISHER, LAND_SPECIES, SALE_TRADER, SHOW_ID };
enum Pending { P_NONE, P_LANDING, P_SALE };
const int BTN_PINS[B_COUNT] = {13, 14, 26, 27};

MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
HX711 hx;
Preferences prefs;

float rawKg = NAN, tareKg = 0;
const int WIN = 8;   // ~0.8 s of readings
float win[WIN];
int winN = 0, winI = 0;

void pushReading(float kg){
  win[winI] = kg;
  winI = (winI + 1) % WIN;
  if (winN < WIN) winN++;
  rawKg = kg;
}

bool isStable(){
  if (winN < WIN) return false;
  float mn = win[0], mx = win[0];
  for (int i = 1; i < WIN; i++) { mn = fminf(mn, win[i]); mx = fmaxf(mx, win[i]); }
  return (mx - mn) <= STABLE_BAND_KG;
}

float netKg() { return isnan(rawKg) ? NAN : rawKg - tareKg; }

void pollScale(){
  static uint32_t last = 0;
  if (millis() - last >= 100 && hx.is_ready()) {
    last = millis();
    pushReading(hx.get_units(1));
  }
}

bool btnDown[B_COUNT];
uint32_t btnChanged[B_COUNT];

int readButton(){
  for (int i = 0; i < B_COUNT; i++) {
    bool down = digitalRead(BTN_PINS[i]) == LOW;
    if (down != btnDown[i] && millis() - btnChanged[i] > 40) {
      btnDown[i] = down;
      btnChanged[i] = millis();
      if (down) return i;
    }
  }
  return -1;
}


Mode mode = IDLE;
Pending pending = P_NONE;
uint32_t pendingSince = 0;
String fisherCard, speciesCode, traderCard, lastUid, lastBatchId;
String spCode[9], spName[9];
int spN = 0, spSel = 0;
String msg;
uint32_t msgUntil = 0;

void resetToIdle() {
  mode = IDLE; pending = P_NONE; spN = 0; spSel = 0;
  fisherCard = ""; speciesCode = ""; traderCard = "";
}

void printLines(const String& text, int y, int maxLines){
  int start = 0, len = text.length();
  for (int line = 0; line < maxLines && start < len; line++) {
    oled.setCursor(0, y + line * 9);
    int end = min(len, start + 21);
    int nl = text.indexOf('\n', start);
    bool brk = (nl >= 0 && nl < end);
    if (brk) end = nl;
    oled.print(text.substring(start, end));
    start = brk ? end + 1 : end;
  }
}


void drawScreen(bool force=false){
  static uint32_t last = 0;
  if (!force && millis() - last < 200) return;
  last = millis();

  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  const char* titles[] = {"FISH PASSPORT", "LANDING", "PICK SPECIES", "SALE", "CARD ID"};
  oled.setCursor(0, 0);
  oled.print(titles[mode]);
  oled.setCursor(110, 0);
  oled.print(WiFi.status() == WL_CONNECTED ? "ok" : "--");

  String hint;
  if (mode == LAND_SPECIES) {
    oled.setTextSize(2);
    oled.setCursor(0, 14);
    oled.print(spName[spSel].substring(0, 10));
    oled.setTextSize(1);
    oled.setCursor(0, 34);
    oled.print(spSel + 1); oled.print(" of "); oled.print(spN);
    hint = "NEXT: change\nLAND: ok  SALE: back";
  } else {
    oled.setTextSize(2);
    oled.setCursor(0, 12);
    float n = netKg();
    if (isnan(n)) oled.print("--.-- kg");
    else { oled.print(n, 2); oled.print("kg"); }
    oled.setTextSize(1);
    oled.setCursor(0, 32);
    oled.print(isStable() ? "steady" : "settling");
    if (tareKg != 0) { oled.print("  tare "); oled.print(tareKg, 2); }

      switch (mode) {
      case IDLE:
        hint = "LAND  SALE  TARE\nNEXT: card ID";
        break;
      case LAND_FISHER:
        hint = pending ? String("Waiting for steady\nweight...") : String("Tap fisher card\nLAND/SALE: cancel");
        break;
      case SALE_TRADER:
        hint = pending ? String("Waiting for steady\nweight...") : String("Batch ") + lastBatchId + "\nTap trader card";
        break;
      case SHOW_ID:
        hint = lastUid.length() ? String("ID ") + lastUid + "\nNEXT: back" : String("Tap a card\nNEXT: back");
        break;
      default:
        break;
    }
  }
   if (millis() < msgUntil) hint = msg;
  printLines(hint, 44, 2);
  oled.display();
}


void showMsg(const String& m, uint32_t ms = 3000){
  msg = m;
  msgUntil = millis() + ms;
  drawScreen(true);
}


String readCardUid() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return "";
  String u;
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) u += "0";
    u += String(rfid.uid.uidByte[i], HEX);
  }
  u.toUpperCase();
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  return u;
}

String hmacHex(const String& message) {
  uint8_t out[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)STATION_SECRET, strlen(STATION_SECRET));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)message.c_str(), message.length());
  mbedtls_md_hmac_finish(&ctx, out);
  mbedtls_md_free(&ctx);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + 2 * i, "%02x", out[i]);
  hex[64] = 0;
  return String(hex);
}

int postJson(const char* path, JsonDocument& body, JsonDocument& resp) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  String payload;
  serializeJson(body, payload);
  String ts = String((uint32_t)time(nullptr));
  String url = String(API_BASE) + path;

  WiFiClientSecure tls;
  tls.setInsecure();  // demo only: pin your server's certificate before real use
  WiFiClient plain;
  HTTPClient http;
  if (url.startsWith("https")) http.begin(tls, url);
  else http.begin(plain, url);
  http.setTimeout(10000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Station-Id", STATION_ID);
  http.addHeader("X-Timestamp", ts);
  http.addHeader("X-Signature", hmacHex(ts + "." + payload));

  int code = http.POST(payload);
  String reply = code > 0 ? http.getString() : "";
  if (reply.length()) deserializeJson(resp, reply);
  http.end();
  Serial.printf("POST %s -> %d %s\n", path, code, reply.c_str());
  return code;
}

void addWeights(JsonDocument& b){
  b["grossKg"] = serialized(String(rawKg, 2));
  b["tareKg"]  = serialized(String(tareKg, 2));
  b["netKg"]   = serialized(String(netKg(), 2));
}

void handleError(int code, JsonDocument& resp){
  String err = resp["error"] | "";
  resetToIdle();
  if (code <= 0)                          showMsg("No network.\nTry again", 4000);
  else if (err == "fisher_not_found")     showMsg("Fisher not found.\nRegister card first", 5000);
  else if (err == "trader_not_found")     showMsg("Trader not found.\nRegister card first", 5000);
  else if (err == "not_a_fisher_card")    showMsg("Not a fisher card.\nPress LAND again", 5000);
  else if (err == "buyer_is_seller")      showMsg("That is the fisher.\nTap TRADER card", 5000);
  else if (err == "not_a_buyer_card")     showMsg("Not a trader card.\nPress SALE again", 5000);
  else if (err == "weight_exceeds_batch") showMsg("More than batch\nweight. Check crate", 5000);
  else if (err == "batch_closed")         showMsg("Batch already sold.\nDo a new landing", 5000);
  else if (err == "bad_weight")           showMsg("Bad weight.\nCheck tare / scale", 5000);
  else if (err == "stale_request")        showMsg("Clock wrong. Check\nWiFi, then restart", 5000);
  else if (code == 401)                   showMsg("Station not\nauthorised", 5000);
  else                                    showMsg("Error " + String(code) + "\n" + err, 5000);
}

void sendLanding(){
  JsonDocument body, resp;
  body["fisherCard"] = fisherCard;
  if (speciesCode.length()) body["speciesCode"] = speciesCode;
  addWeights(body);
  showMsg("Sending...", 10000);

  int code = postJson("/station/landing", body, resp);
  if (code == 200 || code == 201) {
    lastBatchId = resp["batchId"] | "";
    String species = resp["species"] | "";
    float kg = resp["netKg"] | 0.0f;
    String qr = resp["qrUrl"] | "";
    Serial.println("Passport: " + qr);
    resetToIdle();
    showMsg("Batch " + lastBatchId + "\n" + species + " " + String(kg, 2) + "kg", 8000);
  } else if (code == 409 && (resp["needSpecies"] | false)) {
    // No IVR declaration found: ask which species is on the scale.
    spN = 0; spSel = 0;
    for (JsonObject s : resp["speciesOptions"].as<JsonArray>()) {
      if (spN >= 9) break;
      spCode[spN] = s["code"] | "";
      spName[spN] = s["name"] | "";
      spN++;
    }
    if (spN == 0) { resetToIdle(); showMsg("No species list\nfrom server", 4000); return; }
    mode = LAND_SPECIES;
    msgUntil = 0;
  } else {
    handleError(code, resp);
  }

}

void sendSale(){
  JsonDocument body, resp;
  body["batchId"] = lastBatchId;
  body["traderCard"] = traderCard;
  addWeights(body);
  showMsg("Sending...", 10000);

  int code = postJson("/station/sale", body, resp);
  if (code == 200 || code == 201) {
    String trader = resp["traderName"] | "trader";
    resetToIdle();
    showMsg("Sold to " + trader + "\nFisher gets a call", 6000);
  } else {
    handleError(code, resp);
  }
}

void startPending(Pending p) {
  pending = p;
  pendingSince = millis();
}

void servicePending(){
    if (pending == P_NONE) return;
  if (millis() - pendingSince > 60000) { resetToIdle(); showMsg("Timed out"); return; }
  float n = netKg();
  if (isnan(n) || n < MIN_NET_KG || !isStable()) return;
  Pending p = pending;
  pending = P_NONE;
  if (p == P_LANDING) sendLanding();
  else sendSale();
}

void onButton(int b){
    switch (mode) {
    case IDLE:
      if (b == B_LAND) { resetToIdle(); mode = LAND_FISHER; }
      else if (b == B_SALE) {
        if (lastBatchId.length() == 0) showMsg("No batch yet.\nDo a landing first");
        else mode = SALE_TRADER;
      }
      else if (b == B_TARE) {
        if (!isnan(rawKg)) {
          tareKg = (fabsf(rawKg) < MIN_NET_KG) ? 0 : rawKg;
          showMsg(tareKg == 0 ? "Tare cleared" : "Tare set", 1500);
        }
      }
      else if (b == B_NEXT) { lastUid = ""; mode = SHOW_ID; }
      break;
 case LAND_FISHER:
    case SALE_TRADER:
      if (b == B_LAND || b == B_SALE) { resetToIdle(); showMsg("Cancelled", 1500); }
      break;

    case LAND_SPECIES:
      if (b == B_NEXT) spSel = (spSel + 1) % spN;
      else if (b == B_LAND) { speciesCode = spCode[spSel]; mode = LAND_FISHER; startPending(P_LANDING); }
      else if (b == B_SALE) { resetToIdle(); showMsg("Cancelled", 1500); }
      break;

    case SHOW_ID:
      if (b == B_NEXT || b == B_SALE) resetToIdle();
      break;
  }
}

void onCard(const String& uid) {
  lastUid = uid;
  if (mode == SHOW_ID) { Serial.println("Card ID: " + uid); return; }
  if (pending) return;
  if (mode == LAND_FISHER) { fisherCard = uid; startPending(P_LANDING); }
  else if (mode == SALE_TRADER) { traderCard = uid; startPending(P_SALE); }
}


void handleSerialCommands() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd == "zero") {
    hx.tare(20);
    winN = 0;
    Serial.println("zeroed (scale must be empty)");
  } else if (cmd.startsWith("cal ")) {
    float known = cmd.substring(4).toFloat();
    if (known > 0) {
      float f = hx.get_value(20) / known;
      hx.set_scale(f);
      prefs.putFloat("cal", f);
      winN = 0;
      Serial.printf("calibration factor %.2f saved\n", f);
    }
  } else if (cmd == "weight") {
    Serial.printf("gross %.3f kg, net %.3f kg, %s\n", rawKg, netKg(), isStable() ? "steady" : "settling");
  } else {
    Serial.println("commands: zero | cal <kg> | weight");
  }
}


void keepWifi() {
  static uint32_t last = 0;
  if (WiFi.status() != WL_CONNECTED && millis() - last > 10000) {
    last = millis();
    WiFi.reconnect();
  }
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < B_COUNT; i++) pinMode(BTN_PINS[i], INPUT_PULLUP);

  Wire.begin(PIN_SDA, PIN_SCL);
  if (!oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) Serial.println("OLED not found: check wiring / address");
  SPI.begin();
  rfid.PCD_Init();

  prefs.begin("station", false);
  float f = prefs.getFloat("cal", 0);
  hx.begin(PIN_HX_DT, PIN_HX_SCK);
  if (f != 0) hx.set_scale(f);
  else Serial.println("Not calibrated: empty scale -> type 'zero', then known weight -> 'cal <kg>'");
  hx.tare(20);  // scale must be empty at power-on

  showMsg("Connecting WiFi...", 20000);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) delay(500);

  configTime(TZ_OFFSET_S, 0, "pool.ntp.org", "time.google.com");
  for (int i = 0; i < 20 && time(nullptr) < 1700000000; i++) delay(500);  // signed requests need the real time

  showMsg(WiFi.status() == WL_CONNECTED ? "Ready" : "No WiFi yet", 2000);
  Serial.println("Ready. Commands: zero | cal <kg> | weight");
}

void loop() {
  pollScale();
  handleSerialCommands();
  keepWifi();

  int b = readButton();
  if (b >= 0) onButton(b);

  if (mode == LAND_FISHER || mode == SALE_TRADER || mode == SHOW_ID) {
    String uid = readCardUid();
    if (uid.length()) onCard(uid);
  }

  servicePending();
  drawScreen();
}

