/* HRRR near-surface smoke card for Home Assistant.
 * Images are published by NWS Sacramento. No API key or personal data is used.
 */
const SMOKE_BASE = "https://www.weather.gov/images/sto/HRRRSmoke/";
const DEFAULT_TEMPLATE = SMOKE_BASE + "sto_hrrr_smoke_{sector}_f{hour}.png";
const DEFAULT_REGIONS = [
  { name: "San Francisco Bay Area", sector: "cwa", position: "28% 92%", size: "190% auto" },
  { name: "Lake Tahoe", sector: "cwa", position: "100% 64%", size: "190% auto" },
];
const TWO_HOURS = 2 * 60 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

class HrrrSmokeCard extends HTMLElement {
  static getStubConfig() { return { type: "custom:hrrr-smoke-card" }; }

  setConfig(config) {
    const options = config || {};
    const horizons = options.horizons === undefined ? [6, 12, 24] : options.horizons;
    if (!Array.isArray(horizons) || !horizons.length ||
        horizons.some((h) => !Number.isInteger(h) || h < 1 || h > 48)) {
      throw new Error("horizons must contain forecast hours from 1 to 48");
    }
    const regions = options.regions === undefined ? DEFAULT_REGIONS : options.regions;
    if (!Array.isArray(regions) || !regions.length ||
        regions.some((r) => !r || typeof r.name !== "string" || !r.name.trim())) {
      throw new Error("regions must be a nonempty list with a name for each view");
    }
    const template = options.image_template || DEFAULT_TEMPLATE;
    if (typeof template !== "string" || !/\{hour3?\}/.test(template)) {
      throw new Error("image_template must contain {hour} or {hour3}");
    }
    const sourceUrl = options.source_url || "https://www.weather.gov/sto/ExperimentalSmokeForecast";
    if (!/^https?:\/\//i.test(sourceUrl)) throw new Error("source_url must be an HTTP(S) URL");
    this.settings = {
      title: options.title || "Near-surface smoke forecast",
      subtitle: options.subtitle || "Forecast model imagery",
      sourceName: options.source_name || "NWS Sacramento",
      sourceUrl,
      template,
      horizons: [...new Set(horizons)].sort((a, b) => a - b),
      regions: regions.map((r) => ({
        name: r.name.trim(),
        sector: r.sector || "cwa",
        position: r.position || "center",
        size: r.size || "cover",
      })),
    };
    this.horizon = this.settings.horizons.includes(this.horizon) ? this.horizon :
      (this.settings.horizons.includes(12) ? 12 : this.settings.horizons[0]);
    this.availableHours = [0];
    this.imageAge = undefined;
    this.hours = [0];
    this.current = 0;
    this.playing = true;
    this.version = 0;
    this.refreshId = (this.refreshId || 0) + 1;
    this.frameRequestId = (this.frameRequestId || 0) + 1;
    this.activeLayer = 0;
    this.imageCache = new Map();
    clearTimeout(this.playTimer);
    if (!this.root) this.root = this.attachShadow({ mode: "open" });
    const regionMarkup = this.settings.regions.map((_, i) =>
      `<div class="region" id="region-${i}" role="link" tabindex="0"><div class="map-frame"><div class="map" id="map-${i}-0"></div><div class="map" id="map-${i}-1"></div></div><div class="region-label" id="label-${i}"></div></div>`
    ).join("");
    const horizonMarkup = this.settings.horizons.map((h) =>
      `<option value="${h}">${h} hours</option>`
    ).join("");
    this.root.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { overflow: hidden; padding: 20px; border-radius: var(--ha-card-border-radius, 24px); background: var(--ha-card-background, var(--card-background-color)); container-type:inline-size; }
        .top { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:14px; }
        h2 { margin:0; color:var(--primary-text-color); font-size:1.3rem; font-weight:650; letter-spacing:-.02em; }
        .sub, .range { color:var(--secondary-text-color); font-size:.83rem; margin-top:4px; line-height:1.4; }
        .range { color:var(--primary-text-color); font-weight:550; }
        .status { border-radius:999px; padding:7px 10px; background:var(--secondary-background-color); color:var(--secondary-text-color); font-size:.75rem; white-space:nowrap; }
        .status.stale { color:var(--error-color, #b3261e); }
        .maps { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
        .region { position:relative; min-width:0; border-radius:20px; overflow:hidden; background:#182b2d; cursor:pointer; border:1px solid var(--divider-color); }
        .map-frame { aspect-ratio:1.25; position:relative; }
        .map { position:absolute; inset:0; background-repeat:no-repeat; visibility:hidden; }
        .map.active { visibility:visible; }
        .region-label { position:absolute; left:10px; top:10px; padding:7px 10px; border-radius:999px; background:rgba(20,28,30,.8); color:white; font-size:.8rem; font-weight:650; backdrop-filter:blur(8px); }
        .region:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline:2px solid var(--primary-color); outline-offset:2px; }
        .legend { display:flex; align-items:center; gap:10px; margin:15px 0 13px; color:var(--secondary-text-color); font-size:.75rem; }
        .legend[hidden] { display:none; }
        .ramp { height:9px; flex:1; border-radius:99px; background:linear-gradient(90deg,#f1f1ed,#e8c49b,#dc8c49,#aa4623,#651b13,#250804); }
        .controls { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        button { border:0; border-radius:50%; width:39px; height:39px; flex:none; color:var(--primary-text-color); background:var(--secondary-background-color); cursor:pointer; font-size:1.1rem; }
        button:hover { background:var(--primary-color); color:var(--text-primary-color, white); }
        input[type=range] { flex:1; min-width:80px; accent-color:var(--primary-color); cursor:pointer; }
        .hour { color:var(--primary-text-color); font-weight:650; font-variant-numeric:tabular-nums; min-width:78px; text-align:right; }
        .horizon { display:flex; align-items:center; gap:6px; color:var(--secondary-text-color); font-size:.75rem; }
        select { border:1px solid var(--divider-color); border-radius:10px; padding:6px 8px; background:var(--secondary-background-color); color:var(--primary-text-color); font:inherit; }
        .foot { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:6px; margin-top:11px; color:var(--secondary-text-color); font-size:.73rem; }
        a { color:var(--primary-color); text-decoration:none; }
        @container(max-width:700px) { .maps { grid-template-columns:1fr; } .map-frame { aspect-ratio:1.5; } }
        @media(max-width:700px) { ha-card { padding:14px; } }
      </style>
      <ha-card>
        <div class="top"><div><h2 id="title"></h2><div class="sub" id="subtitle"></div><div class="range" id="range">Checking available forecast hours…</div></div><span class="status" id="status">Checking forecast…</span></div>
        <div class="maps">${regionMarkup}</div>
        <div class="legend" id="legend"><span>0</span><div class="ramp"></div><span>240+ µg/m³</span></div>
        <div class="controls"><button id="play" aria-label="Pause animation" title="Pause animation">Ⅱ</button><input id="seek" type="range" min="0" max="0" value="0" aria-label="Forecast hour"><span class="hour" id="hour">F00 · +0h</span><label class="horizon">Show up to <select id="horizon" aria-label="Forecast horizon">${horizonMarkup}</select></label></div>
        <div class="foot"><span id="issued">Checking image times…</span><a id="source" target="_blank" rel="noopener noreferrer"></a></div>
      </ha-card>`;
    this.$ = (id) => this.root.getElementById(id);
    this.$("title").textContent = this.settings.title;
    this.$("subtitle").textContent = this.settings.subtitle;
    this.$("source").textContent = `${this.settings.sourceName} ↗`;
    this.$("source").href = this.settings.sourceUrl;
    this.$("legend").hidden = options.image_template !== undefined && options.show_legend !== true;
    this.$("horizon").value = String(this.horizon);
    this.$("horizon").onchange = (e) => {
      this.horizon = Number(e.target.value);
      if (this.imageAge !== undefined) this.applyHorizon();
    };
    this.$("play").onclick = () => {
      this.playing = !this.playing;
      if (this.playing) this.scheduleNextFrame();
      else clearTimeout(this.playTimer);
      this.updatePlay();
    };
    this.$("seek").oninput = (e) => { this.showFrame(Number(e.target.value)); };
    this.settings.regions.forEach((region, i) => {
      this.$(`label-${i}`).textContent = region.name;
      const container = this.$(`region-${i}`);
      container.setAttribute("aria-label", `Open full ${region.name} forecast image`);
      const open = () => window.open(this.url(region, this.hours[this.current]), "_blank", "noopener,noreferrer");
      container.onclick = open;
      container.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
      for (const layer of [0, 1]) {
        this.$(`map-${i}-${layer}`).style.backgroundPosition = region.position;
        this.$(`map-${i}-${layer}`).style.backgroundSize = region.size;
      }
    });
    if (this.isConnected) this.refresh();
  }

  getCardSize() { return 5; }
  url(region, hour) {
    const path = this.settings.template
      .replaceAll("{sector}", encodeURIComponent(region.sector))
      .replaceAll("{hour3}", String(hour).padStart(3, "0"))
      .replaceAll("{hour}", String(hour).padStart(2, "0"));
    return `${path}${path.includes("?") ? "&" : "?"}v=${this.version}`;
  }

  connectedCallback() {
    if (!this.settings) return;
    this.refresh();
    clearInterval(this.refreshTimer);
    clearTimeout(this.playTimer);
    this.refreshTimer = setInterval(() => this.refresh(), TWO_HOURS);
  }

  disconnectedCallback() {
    clearInterval(this.refreshTimer);
    clearTimeout(this.playTimer);
    this.refreshId++;
    this.frameRequestId++;
    this.imageCache.clear();
  }

  async refresh() {
    const id = ++this.refreshId;
    const version = Math.floor(Date.now() / TWO_HOURS);
    if (version !== this.version) this.imageCache.clear();
    this.version = version;
    const maxHour = Math.max(...this.settings.horizons);
    const requests = new Map();
    const inspect = (region, hour) => {
      const url = this.url(region, hour);
      if (!requests.has(url)) {
        requests.set(url, fetch(url, { method: "HEAD", cache: "no-store" }).then((response) => {
          if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) return null;
          const modified = Date.parse(response.headers.get("last-modified") || "");
          return Number.isFinite(modified) ? modified : null;
        }).catch(() => null));
      }
      return requests.get(url);
    };
    try {
      const series = await Promise.all(this.settings.regions.map((region) =>
        Promise.all(Array.from({ length: maxHour + 1 }, (_, hour) => inspect(region, hour)))
      ));
      if (id !== this.refreshId || !this.isConnected) return;
      const first = series[0][0];
      if (first === null) throw new Error("No current image");
      const hours = [];
      for (let hour = 0; hour <= maxHour; hour++) {
        if (series.some((frames) => frames[hour] === null || Math.abs(frames[hour] - first) > 45 * 60 * 1000)) break;
        hours.push(hour);
      }
      if (!hours.length) throw new Error("No matching frames");
      this.availableHours = hours;
      this.imageAge = Date.now() - first;
      const timestamp = new Date(first).toLocaleString([], { weekday:"short", hour:"numeric", minute:"2-digit", timeZoneName:"short" });
      this.$("issued").textContent = `Images updated ${timestamp} · ${hours.length} matching forecast frames`;
      this.applyHorizon();
    } catch {
      if (id !== this.refreshId || !this.isConnected) return;
      this.$("status").textContent = "Forecast unavailable";
      this.$("status").classList.add("stale");
      this.$("range").textContent = "Could not determine the forecast range.";
      this.$("issued").textContent = "Could not reach forecast imagery; retrying in two hours";
    }
  }

  applyHorizon() {
    this.hours = this.availableHours.filter((hour) => hour <= this.horizon);
    const selected = Math.min(this.current, this.hours.length - 1);
    this.$("seek").max = String(this.hours.length - 1);
    const last = this.hours[this.hours.length - 1];
    this.$("range").textContent = `Available F00–F${String(last).padStart(2, "0")} (+${last}h from run start) · ${this.horizon}h selected`;
    this.$("status").textContent = this.imageAge > SIX_HOURS ? "Forecast may be stale" :
      last < this.horizon ? `${last} of ${this.horizon}h available` : `${this.horizon}h available`;
    this.$("status").classList.toggle("stale", this.imageAge > SIX_HOURS);
    this.showFrame(selected);
  }

  preload(url) {
    if (!this.imageCache.has(url)) {
      const image = new Image();
      let ready;
      if (typeof image.decode === "function") {
        image.src = url;
        ready = image.decode();
      } else {
        ready = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      }
      this.imageCache.set(url, ready.then(() => image).catch(() => {
        this.imageCache.delete(url);
        throw new Error(`Could not load forecast image: ${url}`);
      }));
    }
    return this.imageCache.get(url);
  }

  async showFrame(index = this.current) {
    clearTimeout(this.playTimer);
    const request = ++this.frameRequestId;
    const hour = this.hours[index];
    if (hour === undefined) return;
    const urls = this.settings.regions.map((region) => this.url(region, hour));
    try {
      await Promise.all([...new Set(urls)].map((url) => this.preload(url)));
    } catch {
      if (request === this.frameRequestId) this.scheduleNextFrame(2000);
      return;
    }
    if (request !== this.frameRequestId || !this.isConnected) return;
    const nextLayer = 1 - this.activeLayer;
    urls.forEach((url, i) => {
      this.$(`map-${i}-${nextLayer}`).style.backgroundImage = `url("${url}")`;
    });
    this.settings.regions.forEach((_, i) => {
      this.$(`map-${i}-${nextLayer}`).classList.add("active");
      this.$(`map-${i}-${this.activeLayer}`).classList.remove("active");
    });
    this.activeLayer = nextLayer;
    this.current = index;
    this.$("seek").value = String(index);
    this.$("hour").textContent = `F${String(hour).padStart(2,"0")} · +${hour}h`;
    this.scheduleNextFrame();
    if (this.playing && this.hours.length > 1) {
      const nextHour = this.hours[(index + 1) % this.hours.length];
      const nextUrls = new Set(this.settings.regions.map((region) => this.url(region, nextHour)));
      Promise.all([...nextUrls].map((url) => this.preload(url))).catch(() => {});
    }
  }

  scheduleNextFrame(delay = 950) {
    clearTimeout(this.playTimer);
    if (!this.playing || !this.isConnected || this.hours.length < 2) return;
    this.playTimer = setTimeout(() => this.showFrame((this.current + 1) % this.hours.length), delay);
  }

  updatePlay() {
    this.$("play").textContent = this.playing ? "Ⅱ" : "▶";
    this.$("play").setAttribute("aria-label", this.playing ? "Pause animation" : "Play animation");
    this.$("play").title = this.playing ? "Pause animation" : "Play animation";
  }
}

if (!customElements.get("hrrr-smoke-card")) customElements.define("hrrr-smoke-card", HrrrSmokeCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "hrrr-smoke-card")) {
  window.customCards.push({ type:"hrrr-smoke-card", name:"HRRR Smoke Forecast", description:"Configurable near-surface smoke forecast loop" });
}
