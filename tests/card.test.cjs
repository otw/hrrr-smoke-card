const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeNode {
  constructor() {
    this.style = {};
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    };
  }
  setAttribute() {}
}

class FakeRoot {
  set innerHTML(value) {
    this.html = value;
    this.nodes = new Map();
  }
  getElementById(id) {
    if (!this.nodes.has(id)) this.nodes.set(id, new FakeNode());
    return this.nodes.get(id);
  }
}

class FakeElement {
  constructor() { this.isConnected = false; }
  attachShadow() { return new FakeRoot(); }
}

const registry = new Map();
const current = new Date();
const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
let holdHour = null;
let releaseImage;
class FakeImage {
  decode() {
    const hour = Number(this.src.match(/_f(\d+)\.png/)[1]);
    return hour === holdHour ? new Promise((resolve) => { releaseImage = resolve; }) : Promise.resolve();
  }
}
const context = {
  HTMLElement: FakeElement,
  customElements: {
    get: (name) => registry.get(name),
    define: (name, element) => registry.set(name, element),
  },
  window: { customCards: [], open() {} },
  Image: FakeImage,
  fetch: async (url) => {
    const hour = Number(url.match(/_f(\d+)\.png/)[1]);
    const stamp = hour <= 3 ? current : old;
    return {
      ok: true,
      headers: {
        get: (name) => name === "content-type" ? "image/png" :
          name === "last-modified" ? stamp.toUTCString() : null,
      },
    };
  },
  setInterval() { return 1; },
  clearInterval() {},
  setTimeout() { return 1; },
  clearTimeout() {},
};
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "..", "hrrr-smoke-card.js"), "utf8"),
  context
);

(async () => {
  const Card = registry.get("hrrr-smoke-card");
  const card = new Card();
  card.setConfig({ type: "custom:hrrr-smoke-card" });
  card.isConnected = true;
  await card.refresh();
  await card.showFrame(0);
  assert.deepEqual([...card.hours], [0, 1, 2, 3]);
  assert.equal(card.forecastStart, Math.floor(current.getTime() / 3600000) * 3600000 - 3600000);
  assert.match(card.$("range").textContent, / – .* (PDT|PST)$/);
  assert.doesNotMatch(card.$("range").textContent, /F00/);
  assert.equal(card.$("status").hidden, true);
  card.forecastStart = Date.parse("2026-10-14T00:00:00Z");
  assert.equal(card.forecastWindow(12), "Tue, Oct 13, 5:00 PM – Wed, Oct 14, 5:00 AM PDT");
  card.forecastStart = Math.floor(current.getTime() / 3600000) * 3600000 - 3600000;
  assert.equal(card.$("map-0-1").classList.contains("active"), true);

  holdHour = 2;
  const loading = card.showFrame(2);
  assert.equal(card.current, 0, "the current frame stays visible while the next decodes");
  assert.equal(card.$("map-0-1").classList.contains("active"), true);
  releaseImage();
  await loading;
  assert.equal(card.current, 2);
  assert.equal(card.$("map-0-0").classList.contains("active"), true);
  assert.match(card.$("map-0-0").style.backgroundImage, /_f02\.png/);
  holdHour = null;

  card.$("horizon").onchange({ target: { value: "6" } });
  assert.equal(card.$("status").hidden, true);

  card.isConnected = false;
  card.setConfig({
    image_template: "https://example.org/{sector}/forecast-{hour3}.png",
    regions: [{ name: "Western region", sector: "west", size: "contain" }],
    horizons: [6, 12, 24],
    time_zone: "America/New_York",
    forecast_start_offset_hours: 0,
  });
  assert.match(card.url(card.settings.regions[0], 12), /west\/forecast-012\.png/);
  assert.equal(card.settings.timeZone, "America/New_York");
  assert.equal(card.settings.startOffset, 0);
  assert.equal(card.$("legend").hidden, true);
  assert.throws(() => card.setConfig({ time_zone: "Not/A_Time_Zone" }), /IANA time zone/);
  console.log("Card source and forecast-horizon checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
