/* FlexDCIM trace explorer. No logic values are synthesized by this viewer. */
(function () {
  "use strict";
  const norm = v => v === 0 || v === "0" ? "0" : v === 1 || v === "1" ? "1" : v === "Z" ? "Z" : "X";
  const upperBound = (rows, time, field = 0) => { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (rows[m][field] <= time) lo = m + 1; else hi = m; } return lo; };
  const regionOf = name => /^([A-F])(?:\.|\[|$)/.exec(String(name))?.[1] || "";
  const word = (bits, get) => { if (!bits?.length) return "Untraced"; const v = bits.map(get); if (v.some(x => x === "?")) return "Untraced"; if (v.some(x => x !== "0" && x !== "1")) return v.every(x => x === "Z") ? "Z" : "X"; return v.reduce((n, x, i) => n | (BigInt(x) << BigInt(i)), 0n).toString(); };
  class TraceRuntime {
    constructor(trace) {
      if (!Array.isArray(trace.nets) || !Array.isArray(trace.events) || !Array.isArray(trace.initial)) throw new Error("Case is missing nets, events or initial values.");
      this.data = trace; this.events = trace.events; this.names = trace.nets; this.initial = this.names.map((_, i) => norm(trace.initial[i]));
      this.values = this.initial.slice(); this.old = new Uint8Array(this.events.length); this.cursor = 0; this.time = 0; this.histories = new Map();
      const levels = ["0", "1", "X", "Z"], temp = this.initial.slice(); let last = -1;
      for (let i = 0; i < this.events.length; i++) { const [t, n, v] = this.events[i]; if (!Number.isFinite(t) || t < last || !Number.isInteger(n) || n < 0 || n >= temp.length) throw new Error(`Invalid event ${i}: events must be ordered and reference recorded nets.`); this.old[i] = levels.indexOf(temp[n]); temp[n] = norm(v); last = t; }
      this.levels = levels; this.namesToIndex = new Map(this.names.map((n, i) => [n, i])); this.period = Number(trace.period_fs) || 10000000;
      this.frames = (trace.frames || []).filter(f => Number.isFinite(f.time_fs));
      this.end = Math.max(1, this.events.at(-1)?.[0] || 0, this.frames.at(-1)?.time_fs || 0, Number(trace.end_fs) || 0);
    }
    value(index) { return Number.isInteger(index) && index >= 0 && index < this.values.length ? this.values[index] : "?"; }
    move(cursor, time) { cursor = Math.max(0, Math.min(this.events.length, cursor)); if (cursor < this.cursor) for (let i = this.cursor - 1; i >= cursor; i--) this.values[this.events[i][1]] = this.levels[this.old[i]]; else for (let i = this.cursor; i < cursor; i++) this.values[this.events[i][1]] = norm(this.events[i][2]); this.cursor = cursor; this.time = Math.max(0, Math.min(this.end, time ?? (cursor ? this.events[cursor - 1][0] : 0))); }
    seek(time) { this.move(upperBound(this.events, time), time); }
    history(index) { if (!this.histories.has(index)) { const rows = []; for (const e of this.events) if (e[1] === index) rows.push([e[0], norm(e[2])]); this.histories.set(index, rows); } return this.histories.get(index); }
    at(index, time) { if (!Number.isInteger(index) || index < 0 || index >= this.names.length) return "?"; const h = this.history(index), i = upperBound(h, time); return i ? h[i - 1][1] : this.initial[index]; }
  }
  // Teaching text interprets recorded state. It never changes the circuit state.
  class ActivityNarrator {
    constructor(runtime) {
      this.r = runtime;
      this.eStates = []; this.bStates = [];
      runtime.names.forEach((name, index) => {
        if (name.startsWith("E.control.state.")) this.eStates.push([name.slice(16), index]);
        if (name.startsWith("B.state.")) this.bStates.push([name.slice(8), index]);
      });
      this.transfers = [];
      const root = runtime.namesToIndex.get("F.clk_root");
      const tracked = new Map();
      let rootBefore = runtime.initial[root];
      for (const name of ["F.rst_sys_n", "F.in_valid", "F.in_ready", "F.out_valid", "F.out_ready", "F.rx_kind_q", ...["F.in_data", "F.out_data"].flatMap(n => Array.from({length: 8}, (_, i) => `${n}[${i}]`)), ...Array.from({length: 2}, (_, i) => `F.tx_tag[${i}]`)]) {
        const index = runtime.namesToIndex.get(name); if (index !== undefined) tracked.set(index, runtime.initial[index]);
      }
      const get = name => tracked.get(runtime.namesToIndex.get(name));
      const byte = name => word(Array.from({length: 8}, (_, i) => runtime.namesToIndex.get(`${name}[${i}]`)), i => tracked.get(i) ?? "?");
      // Replay in event order. The source edge precedes the buffered root edge.
      runtime.events.forEach(([time, n, value], index) => {
        if (n === root && rootBefore === "0" && norm(value) === "1" && get("F.rst_sys_n") === "1") {
          if (get("F.in_valid") === "1" && get("F.in_ready") === "1") this.transfers.push({time, index, direction: "Host → F", kind: get("F.rx_kind_q") === "1" ? "payload byte" : get("F.rx_kind_q") === "0" ? "header byte" : "byte (kind unknown)", value: byte("F.in_data")});
          if (get("F.out_valid") === "1" && get("F.out_ready") === "1") {
            const tag = word([0, 1].map(i => runtime.namesToIndex.get(`F.tx_tag[${i}]`)), i => tracked.get(i) ?? "?");
            this.transfers.push({time, index, direction: "F → Host", kind: ({0: "status byte", 1: "result byte", 2: "readback byte"})[tag] || "byte (kind unknown)", value: byte("F.out_data")});
          }
        }
        if (tracked.has(n)) tracked.set(n, norm(value));
        if (n === root) rootBefore = norm(value);
      });
    }
    bit(name) { return this.r.value(this.r.namesToIndex.get(name)); }
    bus(name, width) { return word(Array.from({length: width}, (_, i) => this.r.namesToIndex.get(`${name}[${i}]`)), i => this.r.value(i)); }
    number(name, width) { const v = this.bus(name, width); return /^\d+$/.test(v) ? Number(v) : null; }
    state(rows) { const active = rows.filter(([, i]) => this.r.value(i) === "1"); return active.length === 1 && rows.every(([, i]) => ["0", "1"].includes(this.r.value(i))) ? active[0][0] : null; }
    describe(view = {}) {
      const e = this.state(this.eStates), b = this.state(this.bStates), op = this.number("E.op_code", 3);
      const count = this.number("E.count_m1", 6), a = this.number("E.input_bits_m1", 3), w = this.number("E.weight_bits_m1", 3), mask = this.number("E.exec_mask", 16);
      const out = {e, b, title: "Control state is settling", text: "The recorded one-hot state is changing or unknown. Step through the gate events before interpreting the next operation.", facts: [], next: "Use Event stepping to follow propagation.", transfers: []};
      const phase = (title, text, next) => Object.assign(out, {title, text, next});
      const plusOne = value => value === null ? "?" : value + 1;
      if (this.bit("F.rst_n") === "0") phase("Global reset is active", "F resets the controller and interfaces. BLKs return to the off state, and their stored weights become invalid.", "Release reset, then wait for the recorded reset synchronizer.");
      else if (this.bit("F.rst_sys_n") !== "1") phase("Waiting for reset release", "The external reset is released or unknown. The internal reset has not yet reached a known inactive level.", "The two reset stages use rising edges of the buffered root clock.");
      else if (e) {
        const descriptions = {
          BOOT: ["Controller is starting", "E initializes command reception. No compute task is active.", "Start the five-byte command header."],
          RX_START: ["Prepare the next header", "E asks F to receive a new five-byte command. The previous descriptor is no longer the current task.", "F asserts in_ready when its receiver is ready."],
          HEADER: ["Receive a command header", "F collects five bytes on rising root-clock edges with in_valid = in_ready = 1. E does not execute a partial header.", "After all five bytes, E captures and checks the descriptor."],
          CHECK: ["Check the command", "E checks the command, selected BLKs and slot-valid state before it permits the operation.", "Accept the command or return an error status."],
          HEADER_ERROR: ["Reject the command header", "E returns an error status. The requested memory or compute operation does not start.", "Wait for the host to accept the error byte."],
          HEADER_OK: ["Acknowledge the header", "The write or compute header is valid. F must deliver its status byte before payload reception starts.", "Accept the status, then receive the payload."],
          PAYLOAD_START: ["Prepare payload reception", "E starts the byte receiver for the declared input count. C prepares its payload buffer.", "Accept payload bytes on rising root-clock edges."],
          PAYLOAD: ["Load the input buffer", "F sends accepted payload bytes to C. The receiver must finish the declared count before execution starts.", "Check the complete payload, then request the operation."],
          PAYLOAD_ERROR: ["Reject the input payload", "An input byte exceeded the selected unsigned precision. The complete payload is consumed, but computation does not start.", "Return BAD_INPUT and wait for the next command."],
          OP_REQUEST: ["Request execution", "E holds op_start for B. B accepts the task when op_ready is high at a rising root-clock edge.", "B begins memory access or compute sequencing."],
          OP_WAIT: ["Wait for the access controller", "E keeps the task descriptor stable while B controls the memory and arithmetic phases.", "Wait for B.op_done."],
          COMPLETE: ["Deliver completion status", "The operation has completed. F holds its status byte until the host accepts it.", op === 2 ? "Deliver each selected BLK result next." : op === 1 ? "Deliver the requested readback bytes next." : "Prepare the next command."],
          SEND_START: ["Start result delivery", "E asks D to select the first result from the requested BLKs.", "F sends each 22-bit result in three low-byte-first bytes."],
          SEND_WAIT: ["Deliver compute results", "D selects BLKs in increasing ID order. F sends three bytes per result. The third accepted byte releases that BLK result.", "Finish all selected results before accepting another task."],
          READ_START: ["Start raw readback", "E starts F after B has filled the readback buffer.", "F sends the declared number of raw bytes."],
          READ_WAIT: ["Deliver raw readback", "F reads bytes from C and holds each one until the host accepts it.", "Finish the declared byte count, then receive a new header."],
          POWER_SELECT: ["Select a BLK for power control", "E scans BLK IDs in increasing order. It skips unselected BLKs and those already in the requested state.", "Change only the selected BLK, using the recorded wait states."],
          ON_SUPPLY: ["Power on the selected BLK", "The BLK supply request is on. Isolation and local reset protect its outputs during the supply wait.", "Enable its local clock after the modeled wait."],
          ON_CLOCK: ["Start the local clock branch", "The selected BLK has a clock request. Local reset and output isolation remain active.", "Release the local reset request after the modeled wait."],
          ON_RESET: ["Wait for local reset release", "The local reset synchronizer releases on the BLK clock. Its outputs remain isolated during this wait.", "Remove isolation after the modeled reset wait."],
          ON_ISO: ["Connect the BLK outputs", "E has requested isolation release and waits before marking the BLK ready. Previous weights are not restored.", "Mark the BLK ready; load weights before computation."],
          OFF_STOP: ["Isolate and stop the BLK", "E clears readiness, asserts isolation and reset, and removes the local clock request.", "Remove the supply request after the modeled wait."],
          OFF_SUPPLY: ["BLK power is off", "The supply request is removed. SRAM contents become unknown, and the slot-valid bits are cleared.", "Finish the off wait, then scan the next BLK."],
          POWER_ADVANCE: ["Advance the power sequence", "E advances to the next BLK ID. Supply changes occur one BLK at a time.", "Continue the scan or return completion status."]
        };
        if (descriptions[e]) phase(...descriptions[e]);
        if (e === "OP_WAIT") {
          const phases = {
            WSETUP: ["Set up a weight word", "B selects the word and drives the buffered weight onto BL/BLB. WL is not yet in the write phase.", "Assert WL after setup."],
            WWRITE: ["Write the SRAM word", "B enables WL for the selected word and slot. All 64 word positions are written; positions beyond the payload are zero-filled.", "Close WL, then keep the write data stable."],
            WHOLD: ["Hold the write data", "WL is closed. B keeps the write data stable before it advances to the next word.", "Write the next word or report completion after word 63."],
            TSTART: ["Start the arithmetic tree", "B enables the tree. A clears the accumulator for a compute task; a raw read uses the same access preparation.", "Begin the first access phase."],
            CPREP: ["Prepare the next input bit plane", "C selects the requested input bit. B prepares the evaluation controls on the falling clock phase.", "Evaluate this plane, from the most significant bit toward bit 0."],
            CEVAL: ["Evaluate the input bit plane", "During the high clock phase, the selected DPUs evaluate unsigned 0/W products. The tree forms a 14-bit partial sum. Low-phase dynamic nodes precharge; stored outputs can hold their values.", "Capture PSUM at the next permitted local rising edge."],
            CCAP: ["Prepare the accumulator update", "The captured PSUM drives the shift/add logic: ACC_next = (ACC << 1) + PSUM. The ACC register samples this value at the next enabled local rising edge.", "Update ACC, then prepare the next plane or drain the result after bit 0."],
            CDRAIN: ["Wait for the final results", "B waits for result_valid from every selected BLK. This schedule includes register and control delays.", "Assert op_done when all selected results are valid."],
            RPREP: ["Prepare a raw SRAM read", "B selects one stored weight bit for the current word and slot.", "Evaluate the selected bit."],
            REVAL: ["Evaluate the stored bit", "B allows the read path to settle before sampling its digital value.", "Capture the bit, then advance the bit index."],
            RSTEP: ["Capture a readback bit", "B stores the sampled bit and advances through bits 0 to 7.", "Read the next bit or store the complete byte."],
            RSTORE: ["Store a readback byte", "B commits the assembled byte to C's readback buffer.", "Continue to the next word or report completion."],
            DONE: ["B reports operation complete", "B.op_done reports that the access or compute sequence has finished. E consumes this indication on a root-clock edge.", "E returns status; it then sends results or raw readback as required."]
          };
          if (phases[b]) phase(...phases[b]);
          else if (!b) phase("Access state is settling", "B's one-hot state is changing or unknown. The trace does not yet establish a single access phase.", "Step through propagation events to resolve the phase.");
        }
        if (!["BOOT", "RX_START", "HEADER"].includes(e)) {
          out.facts.push(["Task", ({0: "Write weights", 1: "Raw read", 2: "Compute", 3: "Power on", 4: "Power off"})[op] || "Unknown / unsupported"]);
          out.facts.push(["BLK mask", mask === null ? "Unknown" : `0x${mask.toString(16).padStart(4, "0")}`]);
          if (op !== null && op < 3) out.facts.push(["Slot / count", `${this.bus("E.slot", 3)} / ${plusOne(count)}`]);
          if (op === 2) out.facts.push(["Precision", `U${plusOne(a)} input × U${plusOne(w)} weight`]);
          if (op === 2 && ["OP_WAIT", "COMPLETE", "SEND_START", "SEND_WAIT"].includes(e)) {
            const selectedBlk = Number.isInteger(view.blk) ? view.blk : mask === null ? -1 : Array.from({length: 16}, (_, i) => i).find(i => (mask & (1 << i)) !== 0);
            if (selectedBlk >= 0) {
              out.facts.push([`BLK ${selectedBlk} PSUM / ACC`, `${this.bus(`A.blk${selectedBlk}.psum`, 14)} / ${this.bus(`A.blk${selectedBlk}.result`, 22)}`]);
              out.facts.push([`BLK ${selectedBlk} result_valid`, this.bit(`A.blk${selectedBlk}.result_valid`)]);
            }
          }
        }
        if (e === "HEADER" || e === "PAYLOAD") out.facts.push(["Receiver index", `${this.bus("F.rx_index", 6)} · ${e === "HEADER" ? "5" : plusOne(count)} bytes required`]);
        if (e === "OP_WAIT" && ["CPREP", "CEVAL", "CCAP", "CDRAIN"].includes(b)) out.facts.push(["Bit plane / eval", `${this.bus("B.plane_bit", 3)} / ${this.bit("B.eval_en")}`]);
        if (e === "OP_WAIT" && /^[WR]/.test(b || "")) out.facts.push(["Word index", this.bus("B.word_index", 6)]);
        if (e === "SEND_WAIT") out.facts.push(["BLK / result byte", `${this.bus("D.index", 4)} / ${this.bus("F.result_byte_index", 2)} (0–2)`]);
        if (/^(ON_|OFF_|POWER_)/.test(e)) out.facts.push(["Power scan BLK", this.bus("E.power_index", 4)]);
        if (e === "HEADER_ERROR" || e === "PAYLOAD_ERROR") out.facts.push(["Error", ({1: "BAD_PARAM", 2: "BLK_NOT_READY", 3: "WEIGHT_INVALID", 4: "BAD_INPUT"})[this.number("E.status_code", 3)] || this.bus("E.status_code", 3)]);
      }
      out.states = `E: ${e || "transition / unknown"} · B: ${b || "transition / unknown"}`;
      out.clock = `Source CLK=${this.bit("F.clk")} · buffered root=${this.bit("F.clk_root")}`;
      out.pending = null;
      if (this.bit("F.rst_sys_n") === "1" && this.bit("F.out_valid") === "1") out.pending = this.bit("F.out_ready") === "0" ? `Output held: byte ${this.bus("F.out_data", 8)}, valid=1, ready=0. No transfer occurs while ready is low.` : this.bit("F.out_ready") === "1" ? `Output offered: byte ${this.bus("F.out_data", 8)}, valid=ready=1. Acceptance is sampled at a rising root-clock edge.` : "Output valid is high; ready is unknown. Acceptance is not established.";
      const end = upperBound(this.transfers, this.r.cursor - 1, "index");
      out.transfers = this.transfers.slice(Math.max(0, end - 2), end);
      out.checkpoint = (this.r.data.checkpoints || []).filter(p => p.time_fs <= this.r.time).at(-1) || null;
      return out;
    }
  }
  function deviceDetails(device, runtime) {
    return {kind: device.kind, inputs: device.inputs.map(n => ({name: runtime.names[n], value: runtime.value(n)})), outputs: device.outputs.map(n => ({name: runtime.names[n], value: runtime.value(n)}))};
  }
  // Preserve circuit targets and their children while trace values change.
  // Packet labels can appear between wires, so action nodes use stable keys.
  function circuitNodeKey(node) {
    if (!node || node.nodeType !== 1) return null;
    for (const name of ["id", "data-bundle", "data-signal", "data-net", "data-region", "data-blk", "data-cell", "data-device", "data-scope"]) {
      if (node.hasAttribute(name)) return `${node.localName}:${name}:${node.getAttribute(name)}`;
    }
    if (node.classList.contains("packet")) return `packet:${node.querySelector("animateMotion")?.getAttribute("path")}`;
    return null;
  }
  function syncChildren(parent, fresh) {
    const keyed = new Map();
    for (const child of parent.childNodes) {
      const key = circuitNodeKey(child);
      if (key !== null) { if (!keyed.has(key)) keyed.set(key, []); keyed.get(key).push(child); }
    }
    let cursor = parent.firstChild;
    for (const next of fresh.childNodes) {
      const key = circuitNodeKey(next);
      const sameKind = node => node && node.nodeType === next.nodeType && node.nodeName === next.nodeName;
      let child = key !== null ? keyed.get(key)?.shift() : circuitNodeKey(cursor) === null && sameKind(cursor) ? cursor : null;
      if (!sameKind(child)) child = next.cloneNode(true);
      else if (next.nodeType === 1) {
        for (const attr of [...child.attributes]) if (!next.hasAttribute(attr.name)) child.removeAttribute(attr.name);
        for (const attr of next.attributes) if (child.getAttribute(attr.name) !== attr.value) child.setAttribute(attr.name, attr.value);
        syncChildren(child, next);
      } else if (child.nodeValue !== next.nodeValue) child.nodeValue = next.nodeValue;
      if (child !== cursor) parent.insertBefore(child, cursor);
      cursor = child.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; parent.removeChild(cursor); cursor = next; }
  }
  function updateMarkup(element, html) {
    const fresh = element.cloneNode(false); fresh.innerHTML = html;
    syncChildren(element, fresh);
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { TraceRuntime, ActivityNarrator, deviceDetails, word, upperBound, regionOf, syncChildren };
  if (typeof document === "undefined") return;
  const $ = id => document.getElementById(id), esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const svg = $("circuit"), color = { A: "#bed7f1", B: "#d5e6f6", C: "#c4e6df", D: "#f4d6b2", E: "#ddd0eb", F: "#d7e0e9" };
  const titles = { A: "Memory & arithmetic", B: "Access & phase control", C: "Input & weight buffer", D: "Result delivery", E: "Task & power control", F: "External interface" };
  let comparisonAnchor = null, lessons = [], lessonId = "auto", lessonBlk = null, selectedBundle = null, bundles = new Map(), waveformRows = [], waveDrag = false, overviewDrag = null, narrator, manifest, topology = {}, topologyIndex = null, scopeCache = new Map(), data, runtime, loadTicket = 0, playing = false, previousTick = 0, view = { kind: "chip" }, selected = null, watch = [], signals = [], signalById = new Map(), cells = new Map(), blockSamples = [], devices = [], drivers = [], sinks = [], windowStart = 0, windowEnd = 1, viewBox = [0, 0, 1100, 700], extent = [0, 0, 1100, 700], recent = new Set(), wireId = 0, drag = null, redrawAt = 0;
  const short = (text, n = 35) => text.length > n ? "…" + text.slice(-(n - 1)) : text;
  const timeLabel = fs => fs >= 1e9 ? `${(fs / 1e9).toFixed(3)} μs` : fs >= 1e6 ? `${(fs / 1e6).toFixed(3)} ns` : `${(fs / 1e3).toFixed(3)} ps`;
  const idx = name => runtime?.namesToIndex.get(name);
  const val = index => runtime ? runtime.value(index) : "?";
  const bus = bits => word(bits, val);
  const sameBits = (a, b) => a?.length === b?.length && a.every((v, i) => v === b[i]);
  const isSelected = bits => !!selected && bits.some(n => selected.bits.includes(n));
  const isRecent = bits => bits.some(n => recent.has(n));
  const selectedDevices = () => { const source = new Set(), destination = new Set(); for (const n of selected?.bits || []) { for (const d of drivers[n] || []) source.add(d); for (const d of sinks[n] || []) destination.add(d); } return { source, destination }; };
  const cellKey = (b, t, j, s) => `${b}:${t}:${j}:${s}`;
  const portIndices = list => Array.isArray(list) && list.every(Number.isInteger) ? list : (list || []).map(x => typeof x === "string" ? idx(x) : x).filter(Number.isInteger);

  const embeddedElement = document.getElementById("embedded-flexdcim");
  const embedded = embeddedElement ? JSON.parse(embeddedElement.textContent) : null;
  async function decodeGzip(bytes) {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decode compressed traces. Use a current browser.");
    return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
  }
  async function fetchJSON(file) {
    if (embedded) {
      if (embedded.schema !== "flexdcim-offline-1") throw new Error("Unsupported offline trace bundle.");
      const key = file.replace(/^\.\//, ""), entry = embedded.files[key];
      if (!entry) throw new Error(`Offline bundle is missing ${key}. No network fallback is used.`);
      if (entry.encoding === "json") return entry.data;
      if (entry.encoding !== "gzip-base64") throw new Error(`Unsupported offline encoding for ${key}.`);
      return decodeGzip(Uint8Array.from(atob(entry.data), c => c.charCodeAt(0)));
    }
    const response = await fetch(new URL(file, new URL("./", location.href)), { cache: "no-cache" });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    if (!file.endsWith(".gz")) return response.json();
    if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decode compressed traces. Use a current browser or export uncompressed JSON.");
    const packed = await response.arrayBuffer();
    const bytes = new Uint8Array(packed);
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(bytes));
    const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  async function start() {
    try { manifest = await fetchJSON("./manifest.json"); if (manifest.schema !== "flexdcim-1" || !Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error("This site requires a flexdcim-1 manifest with at least one recorded case.");
      if (manifest.topology_file) { $("loading").textContent = "Loading shared circuit topology…"; topology = await fetchJSON(manifest.topology_file); }
      $("case-count").textContent = manifest.cases.length; let category = ""; $("case-list").innerHTML = manifest.cases.map(c => { const heading = c.category !== category ? `<div class="case-group">${esc(c.category || "Cases")}</div>` : ""; category = c.category; return `${heading}<button class="case-card" data-case="${esc(c.id)}"><strong>${esc(c.title)}</strong><small>${esc(c.summary)}</small></button>`; }).join("");
      $("case-list").addEventListener("click", e => { const card = e.target.closest("[data-case]"); if (card) loadCase(card.dataset.case); });
      const requested = new URL(location.href).searchParams.get("case"); await loadCase(manifest.cases.find(c => c.id === requested)?.id || manifest.cases[0].id);
    } catch (e) { showError(e); }
  }
  function showError(error) { $("loading").hidden = true; $("load-error").hidden = false; $("load-error").innerHTML = `<b>The trace could not be loaded.</b><p>${esc(error.message)}</p><p>Serve this folder over HTTP with its generated manifest and case files. For example: <code>python3 -m http.server 8000</code>. This page does not replace missing traces with demonstration data.</p>`; }
  async function loadCase(id) {
    const ticket = ++loadTicket, entry = manifest.cases.find(c => c.id === id); if (!entry) return; pause(); $("loading").hidden = false; $("loading").textContent = `Loading ${entry.title}…`; $("load-error").hidden = true;
    try { const next = await fetchJSON(entry.file); if (ticket !== loadTicket) return; data = { ...topology, ...next }; runtime = new TraceRuntime(data); narrator = new ActivityNarrator(runtime); lessons = FlexLessons.buildLessons(data); lessonId = "auto"; lessonBlk = null; selectedBundle = null; comparisonAnchor = null; windowStart = 0; windowEnd = runtime.end; selected = null; view = { kind: "chip" }; watch = [];
      signals = (data.signals || []).map((s, i) => ({ ...s, id: String(s.id ?? i), bits: portIndices(s.bits), label: s.label || s.id || `Signal ${i}` })); signalById = new Map(signals.map(s => [s.id, s]));
      if (topologyIndex?.rawDevices === data.devices && topologyIndex?.rawNets === data.nets && topologyIndex?.rawCells === data.cells) {
        ({ devices, drivers, sinks, cells, blockSamples, scopeCache } = topologyIndex);
      } else {
        devices = (data.devices || []).map(d => ({ ...d, inputs: portIndices(d.inputs), outputs: portIndices(d.outputs) })); drivers = Array.from({ length: data.nets.length }, () => []); sinks = Array.from({ length: data.nets.length }, () => []); devices.forEach((d, i) => { d.outputs.forEach(n => drivers[n].push(i)); d.inputs.forEach(n => sinks[n].push(i)); });
        cells = new Map((data.cells || []).map(c => [cellKey(c.blk, c.term, c.bit, c.slot), c])); blockSamples = []; for (const c of data.cells || []) if (!blockSamples[c.blk]) blockSamples[c.blk] = c;
        scopeCache = new Map(); topologyIndex = { rawDevices: data.devices, rawNets: data.nets, rawCells: data.cells, devices, drivers, sinks, cells, blockSamples, scopeCache };
      }
      $("compare-clock").innerHTML = FlexInspection.clockChoices(runtime).map(c => `<option value="${esc(c.name)}" ${c.name === "F.clk_root" ? "selected" : ""}>${esc(c.label)}</option>`).join("");
      $("lesson-task").innerHTML = '<option value="auto">Follow the time cursor</option>' + lessons.map((l, i) => `<option value="${esc(l.id)}">Task ${i + 1} · ${timeLabel(l.start_fs)} · U${l.descriptor.input_bits}×U${l.descriptor.weight_bits}</option>`).join("");
      $("chapters").innerHTML = (data.checkpoints || []).map((p, i) => `<button data-step="${i}" title="${timeLabel(p.time_fs)}"><span>${i + 1}</span>${esc(p.label)}</button>`).join("");
      $("case-title").textContent = data.title || entry.title; $("case-description").textContent = data.summary || entry.summary; $("case-tags").innerHTML = `<span class="tag">${esc(entry.category || "Recorded case")}</span><span class="tag">${(1e9 / runtime.period).toFixed(2)} MHz stimulus</span><span class="tag">Structural model</span>`;
      $("checks").textContent = JSON.stringify(data.checks || { note: "No check summary supplied" }, null, 2); $("evidence-json").textContent = JSON.stringify({ manifest: manifest.evidence || {}, case: data.evidence || {}, checks: data.checks || {} }, null, 2);
      $("checkpoint").innerHTML = `<option value="">Choose an operation…</option>` + (data.checkpoints || []).map(p => `<option value="${p.time_fs}">${esc(p.label)} · ${timeLabel(p.time_fs)}</option>`).join("");
      document.querySelectorAll("[data-case]").forEach(c => c.setAttribute("aria-current", String(c.dataset.case === id))); $("signal-search").value = ""; $("loading").hidden = true; $("app").hidden = false;
      const clock = signals.find(s => /^(clk|root clock|clock)$/i.test(s.label) || s.id === "clk") || signalForNet(idx("clk") ?? idx("F.clk") ?? idx("F.clk_root")); if (clock?.bits.length) watch.push(clock);
      const defaultSignal = signals.find(s => /out_data|result|psum/i.test(s.id)); if (defaultSignal) watch.push(defaultSignal);
      $("trace-stats").textContent = `${data.nets.length.toLocaleString()} traced nodes · ${devices.length.toLocaleString()} devices · ${data.events.length.toLocaleString()} recorded changes`;
      const url = new URL(location.href); url.searchParams.set("case", id); if (!embedded) history.replaceState(null, "", url); changeView(view); seek(0);
    } catch (e) { if (ticket === loadTicket) showError(e); }
  }
  function signalForNet(n) { if (!Number.isInteger(n)) return null; return { id: `net:${n}`, label: data.nets[n], bits: [n], region: regionOf(data.nets[n]) }; }
  function updateRecent() { recent = new Set(); if (!runtime) return; let start = Math.max(0, runtime.time - runtime.period / 2); for (let i = runtime.frames.length - 1; i >= 0; i--) { if (runtime.frames[i].time_fs < runtime.time) { start = runtime.frames[i].time_fs; break; } } for (let i = upperBound(runtime.events, start); i < runtime.cursor; i++) recent.add(runtime.events[i][1]); }
  function seek(t) { if (!runtime) return; comparisonAnchor = null; runtime.seek(Math.max(0, Math.min(runtime.end, t))); refresh(); }
  function refresh() { updateRecent(); $("time-readout").textContent = `${timeLabel(runtime.time)} · cycle ${(runtime.time / runtime.period).toFixed(2)}`; const f = runtime.frames.filter(f => f.time_fs <= runtime.time).at(-1); $("clock-status").textContent = f ? `${f.edge === "rise" ? "↑" : f.edge === "fall" ? "↓" : ""} ${f.edge} · ${f.cycle ?? ""}` : "Before edge"; renderCircuit(false); renderInspector(); renderTimeline(); renderChapters(); renderLesson(); }
  function pause() { playing = false; $("play").textContent = "▶ Play"; svg.pauseAnimations?.(); }
  function stepEdge(direction) { pause(); if (!runtime) return; const frames = runtime.frames; let target = direction > 0 ? frames.find(f => f.time_fs > runtime.time) : [...frames].reverse().find(f => f.time_fs < runtime.time); if (target) { keepVisible(target.time_fs); seek(target.time_fs); } }
  function stepEvent(direction) { pause(); if (!runtime) return; comparisonAnchor = null; const cursor = Math.max(0, Math.min(runtime.events.length, runtime.cursor + direction)); runtime.move(cursor); keepVisible(runtime.time); refresh(); }
  function keepVisible(t) { const span = windowEnd - windowStart; if (t < windowStart || t > windowEnd) { windowStart = Math.max(0, Math.min(runtime.end - span, t - span / 2)); windowEnd = Math.min(runtime.end, windowStart + span); } }
  function animate(now) { if (playing && runtime) { if (previousTick && now - redrawAt >= 75) { const t = runtime.time + (now - previousTick) / 1000 * runtime.period * Number($("speed").value); keepVisible(t); seek(t); redrawAt = now; if (t >= runtime.end) pause(); previousTick = now; } if (!previousTick) previousTick = now; } else previousTick = now; requestAnimationFrame(animate); }

  function changeView(next) { view = next; selectedBundle = null; for (const key of ["blk", "term", "bit", "slot"]) if (Number.isInteger(view[key])) $("loc-" + key).value = view[key]; $("signal-search").value = ""; renderCircuit(true); renderInspector(); }
  function breadcrumbs() { const entries = [{ label: "Chip", action: "chip" }]; if (view.kind === "blocks" || view.kind === "grid" || view.kind === "cell") entries.push({ label: "A · 16 BLKs", action: "blocks" }); if (view.kind === "grid" || view.kind === "cell") entries.push({ label: `BLK ${view.blk}`, action: "grid" }); if (view.kind === "cell") entries.push({ label: `Term ${view.term} · bit ${view.bit} · slot ${view.slot}`, action: "cell" }); if (view.kind === "region") { const pieces = view.scope.split("."); for (let i = 0; i < pieces.length; i++) entries.push({ label: i ? pieces[i] : `${pieces[i]} · ${titles[pieces[i]] || "Logic"}`, action: "scope", scope: pieces.slice(0, i + 1).join(".") }); } const html = entries.map((e, i) => `${i ? "<span>›</span>" : ""}<button class="crumb ${i === entries.length - 1 ? "current" : ""}" data-view="${e.action}" data-scope="${esc(e.scope || "")}">${esc(e.label)}</button>`).join(""); if ($("breadcrumbs").innerHTML !== html) $("breadcrumbs").innerHTML = html; }
  function definitions() { return `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10Z" fill="#93a8bf"/></marker><marker id="active-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10Z" fill="#078e72"/></marker><pattern id="off-hatch" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" fill="#3e4c60"/><path d="M-2 2 L2 -2 M0 9 L9 0 M7 11 L11 7" stroke="#6b7c90" stroke-width="1.3"/></pattern></defs>`; }
  function wire(path, bits, label, x, y, options = {}) { const id = `w${wireId++}`, active = isRecent(bits), chosen = isSelected(bits), value = bus(bits), display = options.compact && value.length > 10 ? value.slice(0, 4) + "…" + value.slice(-3) : value, action = options.bundle ? `data-bundle="${esc(options.bundle)}"` : options.signal ? `data-signal="${esc(options.signal)}"` : Number.isInteger(bits[0]) ? `data-net="${bits[0]}"` : ""; return `<path id="${id}" class="wire ${active ? "changed" : ""} ${chosen ? "selected" : ""}" d="${path}" marker-end="url(#${active ? "active-arrow" : "arrow"})"/><path class="wire-hit" d="${path}" ${action} role="button" tabindex="0" aria-label="Inspect ${esc(label || bits.map(n => data.nets[n]).join(", "))} connection"><title>${esc(label)} = ${esc(value)}</title></path>${label ? `<text class="wire-label ${chosen ? "selected" : ""}" x="${x}" y="${y}" text-anchor="middle">${esc(short(label, options.maxLabel || 27))} = ${esc(display)}</text>` : ""}${active && !options.noMotion ? `<text class="packet">${esc(value.length < 8 ? value : "•")}<animateMotion dur="2s" repeatCount="indefinite" path="${path}"/></text>` : ""}`; }
  function renderCircuit(reset) {
    if (!runtime) return;
    wireId = 0; bundles.clear(); breadcrumbs(); let content; if (view.kind === "chip") content = drawChip(); else if (view.kind === "blocks") content = drawBlocks(); else if (view.kind === "grid") content = drawGrid(); else content = drawDevices();
    if (reset) { svg.innerHTML = definitions() + content; viewBox = view.kind === "grid" || (extent[2] === 1120 && extent[3] > 1100) ? [0, 0, 1100, 760] : extent.slice(); }
    else updateMarkup(svg, definitions() + content);
    svg.setAttribute("viewBox", viewBox.join(" ")); if (!playing) svg.pauseAnimations?.(); else svg.unpauseAnimations?.();
  }
  function setOptions(html) { if ($("view-options").innerHTML !== html) $("view-options").innerHTML = html; }
  function drawChip() { extent = [0, 0, 1100, 720]; setOptions(`<span>Click a region to open its recorded circuitry.</span><span class="hint">Actual values · conceptual placement</span>`);
    const boxes = { C: [410, 45], B: [60, 265], A: [410, 265], D: [760, 265], E: [60, 535], F: [760, 535] }, w = 230, h = 116;
    let flows = signals.filter(s => boxes[s.source] && boxes[s.target] && s.source !== s.target); if (!flows.length) { const pairs = new Map(); devices.forEach(d => d.inputs.forEach(n => (drivers[n] || []).forEach(di => { const a = regionOf(devices[di].name), b = regionOf(d.name); if (a && b && a !== b && !pairs.has(a + b)) pairs.set(a + b, { ...signalForNet(n), source: a, target: b }); }))); flows = [...pairs.values()]; }
    const grouped = new Map(); flows.forEach(s => { const key = s.source + s.target; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(s); }); let links = "", nodes = "";
    const routes = { BA: ["M290 320 H410", 350, 307], AB: ["M410 355 H290", 350, 376], AD: ["M640 320 H760", 700, 307], BC: ["M175 265 V195 H385 V125 H410", 285, 185], CB: ["M410 145 H355 V225 H205 V265", 285, 245], CF: ["M640 115 H1070 V605 H990", 1010, 430], FC: ["M990 565 H1040 V80 H640", 970, 195], EB: ["M150 535 V381", 150, 445], EF: ["M290 580 H760", 525, 568], FE: ["M760 615 H290", 525, 637], DF: ["M850 381 V535", 845, 430], FD: ["M925 535 V381", 945, 480], ED: ["M290 550 H710 V365 H760", 525, 538], BD: ["M290 350 H325 V415 H735 V350 H760", 525, 405] };
    for (const [key, list] of grouped) { const s = list.find(s => isSelected(s.bits)) || list.find(s => isRecent(s.bits)) || list[0], [ax, ay] = boxes[s.source], [bx, by] = boxes[s.target]; let route = routes[key]; if (!route) { const x1 = ax + w / 2, y1 = ay + h, x2 = bx + w / 2, y2 = by, mid = (y1 + y2) / 2; route = [`M${x1} ${y1} V${mid} H${x2} V${y2}`, (x1 + x2) / 2, mid - 10]; } links += wire(route[0], s.bits, `${s.label}${list.length > 1 ? ` (+${list.length - 1})` : ""}`, route[1], route[2], { signal: s.id, bundle: registerBundle(`chip:${key}`, list), maxLabel: 16, compact: true }); }
    const sd = selectedDevices(), regions = new Set([...sd.source, ...sd.destination].map(i => regionOf(devices[i].name))); const info = { A: "16 BLKs · SRAM + PSUM + ACC", B: "WL / RWL · EN / WS · readback", C: "64 × 8-bit staging · zero tail", D: "22-bit results · ordered BLKs", E: "One task · validity · isolation", F: "8-bit input + 8-bit output" };
    for (const [r, [x, y]] of Object.entries(boxes)) { const ss = signals.filter(s => s.region === r || s.source === r), chosen = ss.find(s => isRecent(s.bits)) || ss[0]; nodes += `<g class="clickable" data-region="${r}" tabindex="0" role="button" aria-label="Open region ${r}: ${titles[r]}"><rect class="box ${regions.has(r) || selected?.source === r || selected?.target === r ? "source" : ""}" x="${x}" y="${y}" width="${w}" height="${h}" fill="${color[r]}"/><text x="${x + 17}" y="${y + 31}" class="title">${r} · ${titles[r]}</text><text x="${x + 17}" y="${y + 54}" class="sub">${info[r]}</text><text x="${x + 17}" y="${y + 78}" class="device-name">${chosen ? esc(short(chosen.label, 30)) : "No exported boundary signal"}</text><text x="${x + 17}" y="${y + 101}" class="value">${chosen ? esc(bus(chosen.bits)) : "Untraced"}</text></g>`; }
    return `<text x="550" y="22" text-anchor="middle" class="muted sub">Connections are derived from the trace's exported signal and device inventory</text>${links}${nodes}${!flows.length ? `<text x="550" y="440" text-anchor="middle" class="muted sub">No cross-region connection metadata was recorded. Open a module to inspect its traced nets.</text>` : ""}`;
  }
  function blockPower(b) { return val(blockSamples[b]?.power ?? idx(`E.blk_pwr_en[${b}]`)); }
  function blockReady(b) { return val(idx(`E.blk_ready[${b}]`)); }
  function blockActive(b) { const select = val(idx(`E.exec_mask[${b}]`)), evaluate = val(idx("B.eval_en")); if (select === "0" || evaluate === "0") return false; return select === "1" && evaluate === "1" ? true : null; }
  function drawBlocks() { extent = [0, 0, 1100, 720]; setOptions(`<span>16 independent power domains · 64 terms × 8 weight bits per BLK · 8 stored slots</span>`); let out = `<text x="55" y="37" class="title">Choose a BLK</text><text x="55" y="59" class="sub muted">OFF is different from powered idle. A compute mask does not automatically turn other BLKs off.</text>`;
    for (let b = 0; b < 16; b++) { const x = 55 + (b % 4) * 260, y = 90 + Math.floor(b / 4) * 150, power = blockPower(b), ready = blockReady(b), active = blockActive(b), state = power === "0" ? "OFF · weights not retained" : power !== "1" ? "Power state untraced" : ready === "0" ? "Powered · not ready" : ready !== "1" ? "Powered · readiness untraced" : active === null ? "Powered · activity untraced" : active ? "Powered · evaluating" : "Powered · idle / unselected"; const fill = power === "0" ? "url(#off-hatch)" : active ? "#dcecff" : power === "1" ? "#edf1f5" : "#fff8df", text = power === "0" ? "cell-text-off" : ""; const s = signals.find(s => s.region === "A" && (s.blk === b || new RegExp(`blk${b}(?:\\.|\\[|$)`).test(s.id)) && /psum|acc|result/i.test(s.id)); out += `<g class="clickable" data-blk="${b}" role="button" tabindex="0"><rect class="box" x="${x}" y="${y}" width="230" height="123" fill="${fill}"/><text x="${x + 17}" y="${y + 29}" class="title ${text}">BLK ${b}</text><text x="${x + 17}" y="${y + 53}" class="sub ${text}">${state}</text><text x="${x + 17}" y="${y + 79}" class="sub ${text}">8 slots · 512 DPU bit positions</text><text x="${x + 17}" y="${y + 102}" class="mono sub ${text}">${s ? `${esc(short(s.label, 23))}: ${esc(bus(s.bits))}` : "Open storage & interfaces →"}</text></g>`; } return out; }
  function drawGrid() { const b = view.blk, slot = view.slot ?? 0; extent = [0, 0, 1100, 3000]; setOptions(`<label>Weight slot <select id="slot">${Array.from({ length: 8 }, (_, s) => `<option value="${s}" ${slot === s ? "selected" : ""}>${s}</option>`).join("")}</select></label><button data-open-scope="A.blk${b}.tree">Adder tree</button><button data-open-scope="A.blk${b}.psum_register">PSUM register</button><button data-open-scope="A.blk${b}.accumulator">Accumulator</button><button data-open-scope="A.blk${b}.shift_add">Shift/add logic</button><span class="hint">Pan for all 64 terms · Fit shows the whole BLK</span>`); const power = blockPower(b); let out = `<text x="40" y="30" class="title">BLK ${b} · slot ${slot} · stored Q and DPU interfaces</text><text x="40" y="53" class="sub muted">${power === "0" ? "Power is off. The displayed Q still comes from the trace; it is not a retained-weight guarantee." : "WL activity marks writes; RWL activity marks read/evaluation. Click any bit position to open its actual gates."}</text>`;
    for (let bit = 0; bit < 8; bit++) out += `<text x="${213 + bit * 110}" y="82" text-anchor="middle" class="sub">Weight bit ${bit}</text>`;
    for (let t = 0; t < 64; t++) { const y = 96 + t * 45, row = Array.from({ length: 8 }, (_, j) => cells.get(cellKey(b, t, j, slot))), qs = row.map(c => c?.q); const value = bus(qs), hex = /^\d+$/.test(value) ? Number(value).toString(16).toUpperCase().padStart(2, "0") : value; out += `<text x="25" y="${y + 18}" class="mono sub">term ${t}</text><text x="25" y="${y + 33}" class="cell-small">SRAM ${hex === "Untraced" ? "untraced" : "0x" + esc(hex)}</text>`;
      for (let j = 0; j < 8; j++) { const c = row[j], x = 165 + j * 110, q = val(c?.q), writing = val(c?.wl) === "1", evaluating = val(c?.rwl) === "1", off = val(c?.power) === "0" || power === "0", cls = off ? "off" : writing ? "write-cell" : evaluating ? "active-cell" : q === "X" ? "unknown-cell" : "idle";
        if (c) { out += wire(`M${x - 13} ${y + 14} H${x}`, [c.rwl], "", 0, 0, { noMotion: true }); out += wire(`M${x + 83} ${y + 14} H${x + 99}`, [c.cbl], "", 0, 0, { noMotion: true }); }
        out += `<g class="clickable" data-cell="${t}:${j}" role="button" tabindex="0"><rect class="box ${cls}" x="${x}" y="${y}" width="83" height="35" fill="${off ? "url(#off-hatch)" : ""}"/><text x="${x + 10}" y="${y + 23}" class="cell-value ${off ? "cell-text-off" : ""}">${esc(q)}</text><text x="${x + 32}" y="${y + 13}" class="cell-small ${off ? "cell-text-off" : ""}">${c ? `WL ${val(c.wl)}` : "untraced"}</text><text x="${x + 32}" y="${y + 27}" class="cell-small ${off ? "cell-text-off" : ""}">${c ? `R ${val(c.rwl)} C ${val(c.cbl)}` : "?"}</text><title>${c ? `Stored Q=${q}; WL=${val(c.wl)}; RWL=${val(c.rwl)}; BL=${val(c.bl)}; BLB=${val(c.blb)}; CBL=${val(c.cbl)}` : "No cell record at this position"}</title></g>`;
      }
    } return out;
  }
  function devicesForView() { const key = view.kind === "cell" ? `cell:${view.blk}:${view.term}:${view.bit}:${view.slot}` : view.scope; if (scopeCache.has(key)) return scopeCache.get(key); const records = []; if (view.kind === "cell") { const c = cells.get(cellKey(view.blk, view.term, view.bit, view.slot)); if (!c) return []; const base = `A.blk${view.blk}.term${view.term}.bit${view.bit}`; devices.forEach((d, i) => { if (d.name === base || d.name.startsWith(base + ".")) records.push([d, i]); }); if (!records.length) { const relevant = new Set([c.q, c.wl, c.rwl, c.bl, c.blb, c.cbl].filter(Number.isInteger)); devices.forEach((d, i) => { if (d.outputs.some(n => relevant.has(n)) && regionOf(d.name) === "A") records.push([d, i]); }); } } else devices.forEach((d, i) => { if (d.name === view.scope || d.name.startsWith(view.scope + ".") || (view.scope.length === 1 && d.region === view.scope)) records.push([d, i]); }); scopeCache.set(key, records); return records; }
  function drawDevices() { const records = devicesForView(), scope = view.kind === "cell" ? `A.blk${view.blk}.term${view.term}.bit${view.bit}` : view.scope; let heading = view.kind === "cell" ? `DPU · BLK ${view.blk} / term ${view.term} / bit ${view.bit} / slot ${view.slot}` : `${scope} · connected logic`;
    setOptions(`<span>${esc(heading)}</span><span class="hint">${records.length} recorded devices · click a wire for its actual value</span>`);
    if (!records.length) { extent = [0, 0, 1100, 700]; const c = view.kind === "cell" && cells.get(cellKey(view.blk, view.term, view.bit, view.slot)); let out = `<text x="55" y="65" class="title">No internal device inventory in this scope</text><text x="55" y="95" class="sub muted">The viewer does not construct hypothetical gates. Recorded interface values are shown below.</text>`; const ports = c ? ["q", "wl", "rwl", "bl", "blb", "cbl"].map(p => ({ label: p.toUpperCase(), bits: [c[p]] })) : signals.filter(s => s.region === scope).slice(0, 20); ports.forEach((s, i) => { const x = 60 + i % 4 * 260, y = 145 + Math.floor(i / 4) * 110; out += `<g class="clickable" data-net="${s.bits[0]}"><rect class="box" x="${x}" y="${y}" width="225" height="80" fill="#edf2f8"/><text x="${x + 15}" y="${y + 27}" class="sub">${esc(short(s.label, 25))}</text><text x="${x + 15}" y="${y + 58}" class="value">${esc(bus(s.bits))}</text></g>`; }); return out; }
    if (records.length > 70 && view.kind !== "cell") return drawScopeGroups(records, scope);
    const visible = records.slice(0, 85), local = new Set(visible.map(([, i]) => i)), ranks = new Map(visible.map(([, i]) => [i, 1]));
    for (let pass = 0; pass < 9; pass++) { let changed = false; for (const [d, i] of visible) { if (/DFF|REG|LATCH|SRAM|MEMORY/i.test(d.kind)) continue; const rank = Math.min(9, 1 + Math.max(0, ...d.inputs.flatMap(n => drivers[n].filter(p => local.has(p) && p !== i).map(p => ranks.get(p) || 0)))); if (rank > ranks.get(i)) { ranks.set(i, rank); changed = true; } } if (!changed) break; }
    const uniqueRanks = [...new Set(ranks.values())].sort((a, b) => a - b), rankMap = new Map(uniqueRanks.map((r, i) => [r, i + 1])), columns = new Map(); visible.forEach(([d, i]) => { const r = rankMap.get(ranks.get(i)); if (!columns.has(r)) columns.set(r, []); columns.get(r).push([d, i]); });
    const pos = new Map(), maxRows = Math.max(...[...columns.values()].map(a => a.length)), height = Math.max(600, 130 + maxRows * 130); for (const [r, rows] of columns) rows.forEach(([d, i], j) => pos.set(i, { x: 225 + (r - 1) * 255, y: 95 + j * 130, w: 172, h: 78 })); const outputX = 225 + uniqueRanks.length * 255; extent = [0, 0, outputX + 230, height];
    const boundaryInputs = [...new Set(visible.flatMap(([d]) => d.inputs.filter(n => !drivers[n].some(i => local.has(i)))))], boundaryOutputs = [...new Set(visible.flatMap(([d]) => d.outputs.filter(n => !sinks[n].some(i => local.has(i)) || sinks[n].some(i => !local.has(i)))))];
    const inPos = new Map(boundaryInputs.map((n, i) => [n, [185, 90 + i * Math.max(30, (height - 160) / Math.max(1, boundaryInputs.length))]])), outPos = new Map(boundaryOutputs.map((n, i) => [n, [outputX, 90 + i * Math.max(30, (height - 160) / Math.max(1, boundaryOutputs.length))]])); extent[3] = Math.max(height, ...[...inPos.values(), ...outPos.values()].map(p => p[1] + 70)); let links = "", nodes = ""; const sd = selectedDevices();
    const outputPoint = (di, net) => { const d = devices[di], p = pos.get(di); return [p.x + p.w, p.y + 18 + Math.max(0, d.outputs.indexOf(net)) * Math.min(15, 44 / Math.max(1, d.outputs.length - 1))]; };
    visible.forEach(([d, di]) => { const p = pos.get(di); d.inputs.forEach((n, k) => { const source = drivers[n].find(i => local.has(i)), from = source !== undefined ? outputPoint(source, n) : inPos.get(n), to = [p.x, p.y + 17 + k * Math.min(13, 46 / Math.max(1, d.inputs.length - 1))]; if (!from) return; const mid = (from[0] + to[0]) / 2; const path = from[0] < to[0] ? `M${from[0]} ${from[1]} H${mid} V${to[1]} H${to[0]}` : `M${from[0]} ${from[1]} H${from[0] + 16} V${p.y - 16 - k * 5} H${to[0] - 16} V${to[1]} H${to[0]}`; links += wire(path, [n], "", mid, (from[1] + to[1]) / 2, { noMotion: false }); }); const output = d.outputs.map(val).join(", "); nodes += `<g class="clickable" data-device="${di}" role="button" tabindex="0"><rect class="box gate ${sd.source.has(di) ? "source" : sd.destination.has(di) ? "destination" : ""}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/><text x="${p.x + 14}" y="${p.y + 25}" class="device-kind">${esc(d.kind || "Device")}</text><text x="${p.x + 14}" y="${p.y + 43}" class="device-name">${esc(short(d.name.split(".").slice(-2).join("."), 25))}</text><text x="${p.x + 14}" y="${p.y + 65}" class="value">out ${esc(short(output || "Untraced", 18))}</text><title>${esc(d.name)} — ${esc(d.kind)}</title></g>`; d.inputs.forEach((n, k) => { const y = p.y + 17 + k * Math.min(13, 46 / Math.max(1, d.inputs.length - 1)); nodes += `<circle class="port clickable" cx="${p.x}" cy="${y}" r="4" data-net="${n}"><title>${esc(data.nets[n])}=${val(n)}</title></circle>`; }); });
    for (const [n, [x, y]] of inPos) nodes += `<g class="clickable" data-net="${n}"><rect class="boundary" x="10" y="${y - 14}" width="175" height="29"/><text x="18" y="${y + 4}" class="device-name">${esc(short(data.nets[n], 20))}</text><text x="174" y="${y + 4}" text-anchor="end" class="mono sub">${val(n)}</text></g>`;
    for (const [n, [x, y]] of outPos) { const di = drivers[n].find(i => local.has(i)); if (di !== undefined) { const p = outputPoint(di, n), mid = (p[0] + x) / 2; links += wire(`M${p[0]} ${p[1]} H${mid} V${y} H${x}`, [n], "", 0, 0); } nodes += `<g class="clickable" data-net="${n}"><rect class="boundary" x="${x}" y="${y - 14}" width="200" height="29"/><text x="${x + 10}" y="${y + 4}" class="device-name">${esc(short(data.nets[n], 24))}</text><text x="${x + 190}" y="${y + 4}" text-anchor="end" class="mono sub">${val(n)}</text></g>`; }
    return `<text x="20" y="32" class="title">${esc(heading)}</text><text x="20" y="55" class="sub muted">Inputs → combinational devices → storage / outputs. Feedback and stateful elements retain their recorded connections.</text>${links}${nodes}`;
  }
  function drawScopeGroups(records, scope) { const scopeSelection = selectedDevices(); const groups = new Map(); records.forEach(([d, i]) => { const rem = d.name.startsWith(scope + ".") ? d.name.slice(scope.length + 1) : d.name; const segment = rem.split(".")[0], key = scope + "." + segment; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(i); }); const entries = [...groups.entries()]; if (entries.length === 1 && entries[0][0] !== scope && entries[0][0].split(".").length < 12) { const [child, ids] = entries[0]; return drawScopeGroups(ids.map(i => [devices[i], i]), child); } const n = entries.length, positions = new Map(entries.map(([key], i) => [key, [70 + i % 4 * 265, 100 + Math.floor(i / 4) * 150]])), owner = new Map(); entries.forEach(([key, ids]) => ids.forEach(i => owner.set(i, key))); extent = [0, 0, 1120, Math.max(650, 120 + Math.ceil(n / 4) * 150)]; const pair = new Map(); records.forEach(([d, i]) => d.inputs.forEach(net => drivers[net].forEach(di => { const a = owner.get(di), b = owner.get(i); if (a && b && a !== b ) { const key = a + "|" + b; if (!pair.has(key)) pair.set(key, {a, b, nets: new Set()}); pair.get(key).nets.add(net); } }))); let out = `<text x="65" y="38" class="title">${esc(scope)} · choose a connected subcircuit</text><text x="65" y="62" class="sub muted">${records.length} devices are grouped by their recorded hierarchy. Open a group to see its individual gates.</text>`; for (const { a, b, nets } of pair.values()) { const list = [...nets].map(n => ({...signalForNet(n), source:a, target:b})), representative = list.find(s => isSelected(s.bits)) || list[0], net = representative.bits[0]; const [ax, ay] = positions.get(a), [bx, by] = positions.get(b); out += wire(`M${ax + 112} ${ay + 100} V${ay + 118} H${bx + 112} V${by}`, [net], "", 0, 0, { noMotion: true, bundle: registerBundle(`scope:${a}|${b}`, list) }); } for (const [key, ids] of entries) { const [x, y] = positions.get(key), bits = devices[ids[0]].outputs; out += `<g class="clickable" data-scope="${esc(key)}" role="button" tabindex="0"><rect class="box ${ids.some(i => scopeSelection.source.has(i) || scopeSelection.destination.has(i)) ? "source" : ""}" x="${x}" y="${y}" width="225" height="100" fill="${color[regionOf(key)] || "#edf2f8"}"/><text x="${x + 13}" y="${y + 28}" class="sub">${esc(short(key, 28))}</text><text x="${x + 13}" y="${y + 52}" class="sub muted">${ids.length} recorded devices</text><text x="${x + 13}" y="${y + 78}" class="value">${bits.length ? esc(bus(bits)) : "Open →"}</text></g>`; } return out; }

  function registerBundle(key, list) { bundles.set(key, list); return key; }
  const lessonWord = w => !w ? "—" : w.value === null ? w.bits : String(w.value);
  function renderLesson() {
    const state = FlexLessons.getLessonAt(lessons, runtime.time, lessonId === "auto" ? null : lessonId, runtime.cursor), lesson = state.lesson;
    $("lesson-start").disabled = !lesson;
    if (!lesson) { $("lesson-blk").innerHTML = ""; $("lesson-body").innerHTML = "<p>No accepted compute task is recorded in this case. Follow the case steps for writes, reads, reset and power control.</p>"; return; }
    if (!lesson.blocks.some(b => b.blk === lessonBlk)) lessonBlk = lesson.blocks[0]?.blk;
    const html = lesson.blocks.map(b => `<option value="${b.blk}" ${b.blk === lessonBlk ? "selected" : ""}>BLK ${b.blk}</option>`).join("");
    if ($("lesson-blk").innerHTML !== html) $("lesson-blk").innerHTML = html;
    const block = lesson.blocks.find(b => b.blk === lessonBlk), actual = state.recorded.find(b => b.blk === lessonBlk), d = lesson.descriptor;
    if (!block) { $("lesson-body").textContent = "The accepted descriptor has no selected BLK."; return; }
    const inputs = lesson.input.effective, weights = block.effective_weights, reference = block.reference;
    const visibleTerms = inputs.map((x, i) => ({x, w:weights[i], i})).slice(0, d.input_count);
    const dotText = visibleTerms.map(t => `${lessonWord(t.x)} × ${lessonWord(t.w)}`).join(" + ");
    const termsOpen = $("lesson-terms")?.open;
    const sampleLink = sample => sample ? `<button class="sample-jump" data-sample-time="${sample.time_fs}" data-sample-event="${sample.event_index + 1}">${esc(lessonWord(sample.word))}<small>${timeLabel(sample.time_fs)}</small></button>` : "<span class='muted'>Not captured yet</span>";
    const lastAcc = actual?.acc_samples.at(-1), result = actual?.result;
    const traceNotes = lesson.issues.length ? `<p class="lesson-state future"><b>Full-trace notes — these may refer to events after the cursor</b>${lesson.issues.map(esc).join(" · ")}</p>` : "";
    $("lesson-body").innerHTML = `<div class="lesson-state ${state.reference_is_future ? "future" : ""}"><b>${state.reference_is_future ? "REFERENCE PREVIEW — this task has not started at the cursor" : `Recorded task state: ${esc(state.phase.replaceAll("_", " "))}`}</b><span>Accepted at ${timeLabel(lesson.start_fs)} · slot ${d.weight_slot} · ${d.input_count} inputs · ${lesson.input.padding_count} zero-padded terms · U${d.input_bits}×U${d.weight_bits}</span></div>
      <div class="lesson-equation"><small>REFERENCE ARITHMETIC FROM THE ACCEPTED INPUT AND SRAM SNAPSHOT</small><p>${esc(dotText)}${d.input_count < 64 ? ` + ${64 - d.input_count} zero-input terms` : ""} = <strong>${esc(lessonWord(reference.dot))}</strong></p><p>Effective weight = stored byte AND ${(1 << d.weight_bits) - 1}. Inputs are unsigned. All 64 physical terms are included.</p></div>
      <div class="result-comparison"><div><small>REFERENCE FINAL RESULT</small><b>${esc(lessonWord(reference.dot))}</b></div><div><small>LAST OBSERVED ACC COMMIT</small><b>${esc(lessonWord(lastAcc?.word))}</b></div><div><small>RECORDED FINAL RESULT</small><b>${result ? esc(lessonWord(result.word)) : "Not ready yet"}</b></div><div><small>HOST DELIVERY</small><b>${actual?.delivery_fs !== null && actual?.delivery_fs !== undefined ? timeLabel(actual.delivery_fs) : "Not delivered yet"}</b></div></div>
      <p class="micro-note">The reference calculation explains the task; it is not a sampled circuit value. Recorded columns include only events already reached by the time cursor. PSUM capture and ACC update occur in separate register stages.</p>
      <div class="table-scroll"><table class="plane-table"><thead><tr><th>Input plane<br>MSB → LSB</th><th>Reference PSUM<br>Σ(input bit × weight)</th><th>Reference ACC update<br>2 × previous ACC + PSUM</th><th>Recorded PSUM</th><th>Recorded ACC</th></tr></thead><tbody>${reference.planes.map(p => { const ps = actual?.psum_samples.find(s => s.bit === p.bit), ac = actual?.acc_samples.find(s => s.bit === p.bit); return `<tr class="${ps && !ac ? "changed-row" : ""}"><td>Bit ${p.bit}</td><td>${esc(lessonWord(p.psum))}</td><td>2 × ${esc(lessonWord(p.acc_before))} + ${esc(lessonWord(p.psum))} = <b>${esc(lessonWord(p.acc_after))}</b></td><td>${sampleLink(ps)}</td><td>${sampleLink(ac)}</td></tr>`; }).join("")}</tbody></table></div>
      <details id="lesson-terms" ${termsOpen ? "open" : ""}><summary>All 64 terms: input bits, stored weights and effective products</summary><div class="table-scroll terms-scroll"><table><thead><tr><th>Term</th><th>C-buffer byte</th><th>Effective input<br>binary / decimal</th><th>Stored weight</th><th>Effective weight</th>${reference.planes.map(p => `<th>Bit ${p.bit}<br>input × W</th>`).join("")}<th>X × W</th></tr></thead><tbody>${inputs.map((x, t) => `<tr class="${t >= d.input_count ? "padded-term" : ""}"><td>${t}${t >= d.input_count ? " · padded" : ""}</td><td>${esc(lessonWord(lesson.input.raw[t]))}</td><td><code>${esc(x.bits)}</code> / ${esc(lessonWord(x))}</td><td>${esc(lessonWord(block.stored_weights[t]))}</td><td>${esc(lessonWord(weights[t]))}</td>${reference.planes.map(p => `<td>${esc(p.input_bits[t])} × ${esc(lessonWord(weights[t]))} = ${esc(lessonWord(p.products[t]))}</td>`).join("")}<td>${esc(lessonWord(reference.products[t]))}</td></tr>`).join("")}</tbody></table></div></details>${traceNotes}`;
  }

  function renderChapters() {
    const checkpoints = data.checkpoints || [];
    const current = checkpoints.reduce((last, p, i) => p.time_fs <= runtime.time ? i : last, -1);
    $("chapters").querySelectorAll("button").forEach((button, i) => {
      button.classList.toggle("past", i < current); button.classList.toggle("current", i === current);
      button.setAttribute("aria-current", i === current ? "step" : "false");
    });
  }
  function renderBundle() {
    const list = bundles.get(selectedBundle) || [];
    $("bundle-controls").hidden = list.length < 2;
    if (list.length < 2) return;
    const html = list.map((s, i) => `<option value="${i}" ${sameBits(s.bits, selected?.bits) ? "selected" : ""}>${esc(s.label)} = ${esc(bus(s.bits))}</option>`).join("");
    if ($("bundle-signal").innerHTML !== html) $("bundle-signal").innerHTML = html;
  }
  function renderEdgeComparison() {
    let bits = selected?.bits || [];
    if (selected?.device !== undefined) bits = [...new Set([...devices[selected.device].inputs, ...devices[selected.device].outputs])];
    if (!bits.length && view.kind === "cell") {
      const c = cells.get(cellKey(view.blk, view.term, view.bit, view.slot));
      bits = ["q", "qb", "wl", "rwl", "bl", "blb", "en", "ws", "cbl", "blx", "bli", "power"].map(k => c?.[k]).filter(Number.isInteger);
    }
    if (!bits.length) { $("edge-comparison").innerHTML = "<p>Select a signal, a gate, or open a cell to compare values.</p>"; return; }
    const comparison = FlexInspection.compareAtEdge(runtime, bits, {clock: $("compare-clock").value, edge: $("compare-edge").value});
    if (comparisonAnchor) {
      comparison.reference = comparisonAnchor;
      comparison.rows = bits.map(index => { const before = FlexInspection.valueBeforeEvent(runtime,index,comparisonAnchor.index), current = val(index); return {index,name:data.nets[index],before,current,changed:before !== current}; });
      comparison.beforeWord = word(bits, n => FlexInspection.valueBeforeEvent(runtime,n,comparisonAnchor.index));
    }
    const r = comparison.reference;
    $("edge-comparison").innerHTML = `<p class="micro-note">${r ? `${comparisonAnchor ? "Pinned reference: " : ""}${esc(r.clock)} · ${r.edge} at ${timeLabel(r.time)}. Before means immediately before that clock event. Now is ${timeLabel(runtime.time)}; propagation may still be in progress.` : "No matching clock edge has occurred at this cursor. Earlier values are not assumed."}</p>${r ? '<div class="edge-jumps"><button data-edge-position="before">Before edge</button><button data-edge-position="at">At edge</button></div>' : ""}${selected?.device === undefined ? `<div class="compare-word">${esc(comparison.beforeWord)} → ${esc(comparison.currentWord)}</div>` : ""}<div class="table-scroll"><table class="compare-table"><thead><tr><th>Recorded node</th><th>Before</th><th>Now</th></tr></thead><tbody>${comparison.rows.map(row => `<tr class="${row.changed ? "changed-row" : ""}"><td title="${esc(row.name)}">${esc(row.name)}</td><td>${esc(row.before ?? "—")}</td><td>${esc(row.current)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function openLocatedCell(termDelta = 0, bitDelta = 0) {
    const limits = {blk: 15, term: 63, bit: 7, slot: 7}, next = {kind: "cell"};
    for (const [key, max] of Object.entries(limits)) {
      const input = $("loc-" + key), value = input.valueAsNumber;
      if (!Number.isInteger(value) || value < 0 || value > max) { input.reportValidity(); return; }
      next[key] = value;
    }
    next.term = Math.max(0, Math.min(63, next.term + termDelta)); next.bit = Math.max(0, Math.min(7, next.bit + bitDelta));
    selected = null; changeView(next); svg.focus({preventScroll:true});
  }
  function setTimeWindow(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > runtime.end || start >= end) return false;
    windowStart = start; windowEnd = end; renderTimeline(); return true;
  }
  function renderOverview() {
    $("overview-window").style.left = `${windowStart / runtime.end * 100}%`;
    $("overview-window").style.width = `${(windowEnd - windowStart) / runtime.end * 100}%`;
    const html = (data.checkpoints || []).map((p, i) => `<span class="${p.time_fs <= runtime.time ? "past" : ""}" style="left:${p.time_fs / runtime.end * 100}%" title="${esc(p.label)}"></span>`).join("");
    if ($("overview-steps").innerHTML !== html) $("overview-steps").innerHTML = html;
    if (document.activeElement !== $("window-start-ns")) $("window-start-ns").value = (windowStart / 1e6).toFixed(6);
    if (document.activeElement !== $("window-end-ns")) $("window-end-ns").value = (windowEnd / 1e6).toFixed(6);
  }
  function wavePosition(event) {
    const rect = $("waves").getBoundingClientRect(), box = $("waves").viewBox.baseVal;
    const x = (event.clientX - rect.left) / rect.width * box.width, y = (event.clientY - rect.top) / rect.height * box.height;
    return {time: Math.round(windowStart + Math.max(0, Math.min(1, (x - 245) / 835)) * (windowEnd - windowStart)), row: Math.floor((y - 27) / 54), inPlot: x >= 245};
  }
  function showWaveHover(event) {
    const p = wavePosition(event), signal = waveformRows[p.row], hover = $("wave-hover");
    hover.hidden = !p.inPlot || !signal;
    if (!p.inPlot || !signal) return;
    const v = word(signal.bits, n => runtime.at(n, p.time));
    hover.textContent = `${signal.label} · ${timeLabel(p.time)} · ${v}${signal.levels && (v === "0" || v === "1") ? ` (${v === "1" ? "0.8" : "0"} V illustration)` : ""}`;
  }

  function selectSignal(s) { if (!s) return; if (!(bundles.get(selectedBundle) || []).some(member => sameBits(member.bits,s.bits))) selectedBundle = null; selected = s; renderCircuit(false); renderInspector(); }
  function renderActivity() {
    const a = narrator.describe(view);
    $("activity-title").textContent = a.title;
    $("activity-explanation").textContent = a.text;
    $("activity-state").textContent = a.states;
    $("activity-clock").textContent = a.clock;
    $("activity-facts").innerHTML = a.facts.map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join("");
    $("activity-next").textContent = a.next;
    $("activity-pending").hidden = !a.pending;
    $("activity-pending").textContent = a.pending || "";
    $("activity-transfers").innerHTML = a.transfers.length ? a.transfers.map(t => `<li><b>${esc(t.direction)}</b> · ${esc(t.kind)} = <strong>${esc(t.value)}</strong><small>Accepted at ${timeLabel(t.time)}</small></li>`).join("") : "<li>No accepted external bytes yet.</li>";
    $("activity-step").textContent = a.checkpoint ? `Case marker: ${a.checkpoint.label}` : "Before the first case marker";
  }
  function renderDeviceDetails(device) {
    const d = FlexInspection.explainDevice(device, runtime);
    return `<section class="gate-explanation"><h3>${esc(d.kind)} · how this device works</h3>${d.lines.map(line => `<p>${esc(line)}</p>`).join("")}${d.delayFs === null ? "" : `<p class="micro-note">Modeled delay: ${timeLabel(d.delayFs)}. This is not physical timing evidence.</p>`}<div class="net-detail gate-inputs"><small>INPUTS AT THIS CURSOR</small>${d.inputs.map(x => `<div><b>${esc(x.role)}</b>: <code>${esc(x.name)}</code> = <b>${esc(x.value)}</b></div>`).join("")}</div></section>`;
  }
  function renderInspector() { if (!runtime) return; renderActivity(); renderBundle(); renderEdgeComparison(); $("watch-selected").disabled = !selected?.bits.length; $("next-change").disabled = !selected?.bits.length; if (selected) { $("inspector-title").textContent = selected.label; const src = new Set(), dst = new Set(); for (const n of selected.bits) { (drivers[n] || []).forEach(i => src.add(devices[i].name)); (sinks[n] || []).forEach(i => dst.add(devices[i].name)); } const netNames = selected.bits.map(n => data.nets[n] || "Untraced"); $("inspector-body").innerHTML = `<div class="value-large">${esc(bus(selected.bits))}</div><p>${selected.bits.length}-bit ${selected.bits.length > 1 ? "unsigned bus · bits listed LSB first" : "logic node"}</p><div class="net-detail"><small>SOURCE</small><b>${esc(selected.source || [...src].map(s => short(s, 55)).join(" · ") || "External / unrecorded driver")}</b></div><div class="net-detail"><small>DESTINATION</small><b>${esc(selected.target || [...dst].slice(0, 9).map(s => short(s, 55)).join(" · ") || "Boundary output / no recorded consumer")}${dst.size > 9 ? ` (+${dst.size - 9})` : ""}</b></div><div class="net-detail"><small>RECORDED NODES</small><code>${netNames.slice(0, 32).map(esc).join("<br>")}</code></div>${selected.device !== undefined ? renderDeviceDetails(devices[selected.device]) : selected.role ? `<p>${esc(selected.role)}</p>` : ""}`; } else { $("inspector-title").textContent = "Select a wire or a node"; $("inspector-body").innerHTML = `<p>Click a connection to see its source, destination and actual value at ${timeLabel(runtime.time)}. Select a gate to inspect its output and input connections.</p>`; }
    const query = $("signal-search").value.toLowerCase(), scope = $("signal-scope").value === "all" ? "" : view.kind === "region" ? view.scope : view.kind === "cell" ? `A.blk${view.blk}.term${view.term}.bit${view.bit}` : view.kind === "grid" ? `A.blk${view.blk}` : ""; let list = signals.filter(s => (!scope || s.region === scope || s.id.startsWith(scope) || s.bits.some(n => data.nets[n]?.startsWith(scope))) && (!query || (s.label + " " + s.id).toLowerCase().includes(query)));
    if (query || !list.length) { const seen = new Set(list.flatMap(s => s.bits.length === 1 ? s.bits : [])); data.nets.forEach((name, i) => { if (list.length < 90 && !seen.has(i) && (!scope || name.startsWith(scope)) && (!query || name.toLowerCase().includes(query))) list.push(signalForNet(i)); }); }
    $("signal-list").innerHTML = list.slice(0, 65).map(s => `<button class="signal-item ${selected && sameBits(selected.bits, s.bits) ? "selected" : ""}" ${s.id.startsWith("net:") ? `data-net="${s.bits[0]}"` : `data-signal="${esc(s.id)}"`}><span>${esc(short(s.label, 50))}</span><code>${esc(bus(s.bits))}</code></button>`).join("") || `<p class="empty">No recorded signals match this scope.</p>`;
  }
  function addWatch() { if (!selected || watch.some(s => sameBits(s.bits, selected.bits))) return; watch.push({ ...selected }); renderTimeline(); }
  function signalSegments(s, from, to) { const points = new Set([from, to]); for (const n of s.bits) for (const [t] of runtime.history(n)) if (t > from && t < to) { points.add(t); if (points.size > 2500) return null; } const times = [...points].sort((a, b) => a - b); return times.slice(0, -1).map((t, i) => [t, times[i + 1], word(s.bits, n => runtime.at(n, t))]); }
  function renderTimeline() { if (!runtime) return; $("seek").min = windowStart; $("seek").max = windowEnd; $("seek").value = runtime.time; $("window-pan").max = Math.max(0, runtime.end - (windowEnd - windowStart)); $("window-pan").value = windowStart; $("window-start").textContent = timeLabel(windowStart); $("window-end").textContent = timeLabel(windowEnd); $("event-readout").textContent = `Event ${runtime.cursor.toLocaleString()} / ${runtime.events.length.toLocaleString()}`; renderOverview(); $("watch-chips").innerHTML = watch.map((s, i) => `<span class="watch-chip">${esc(short(s.label, 45))} <button data-expand-watch="${i}" aria-pressed="${!!s.expanded}" aria-label="Toggle bit levels for ${esc(s.label)}">${s.expanded ? "Bus value" : "Bit levels"}</button> <button data-remove-watch="${i}" aria-label="Remove ${esc(s.label)}">×</button></span>`).join("");
    $("voltage").checked = watch.length > 0 && watch.every(s => s.expanded); const rows = waveformRows = watch.flatMap(s => s.expanded ? s.bits.map((n, i) => ({ ...signalForNet(n), levels: true, label: s.bits.length > 1 ? `${s.label}[${i}]` : s.label })) : [s]); const width = 1100, x0 = 245, plotWidth = width - x0 - 20, height = Math.max(125, rows.length * 54 + 42), x = t => x0 + (t - windowStart) / Math.max(1, windowEnd - windowStart) * plotWidth; let out = "";
    for (let i = 0; i <= 5; i++) { const t = windowStart + (windowEnd - windowStart) * i / 5; out += `<line class="grid-line" x1="${x(t)}" y1="23" x2="${x(t)}" y2="${height}"/><text class="time-label" x="${x(t)}" y="13" text-anchor="${i === 5 ? "end" : "start"}">${timeLabel(t)}</text>`; }
    rows.forEach((s, row) => { const y = 27 + row * 54, segments = signalSegments(s, windowStart, windowEnd); out += `<text x="4" y="${y + 20}" class="device-name">${esc(short(s.label, 32))}</text><text x="4" y="${y + 37}" class="mono sub">${s.levels ? val(s.bits[0]) === "0" ? "0 V" : val(s.bits[0]) === "1" ? "0.8 V" : val(s.bits[0]) : esc(bus(s.bits))}</text>`; if (!segments) { out += `<rect x="${x0}" y="${y + 4}" width="${plotWidth}" height="32" fill="#eff3f8"/><text x="${x0 + 12}" y="${y + 25}" class="sub muted">Dense event activity — zoom the time window to resolve every transition.</text>`; return; }
      let previous = null; for (const [a, b, value] of segments) { const xa = x(a), xb = x(b), w = Math.max(.3, xb - xa); if (s.levels && (value === "0" || value === "1")) { const level = value === "1" ? y + 5 : y + 34; out += `<path class="wave-line" d="M${xa} ${previous === null ? level : previous} V${level} H${xb}"/>`; previous = level; } else { out += `<rect class="${/^\d+$/.test(value) ? "bus-segment" : "wave-unknown"}" x="${xa}" y="${y + 5}" width="${w}" height="29"/>${w > value.length * 7 + 14 ? `<text x="${xa + w / 2}" y="${y + 24}" text-anchor="middle" class="mono sub">${esc(value)}</text>` : ""}`; previous = null; } }
    }); if (!rows.length) out += `<text x="270" y="72" class="sub muted">Add a recorded signal from the inspector to begin.</text>`; if (runtime.time >= windowStart && runtime.time <= windowEnd) out += `<line class="wave-cursor" x1="${x(runtime.time)}" y1="20" x2="${x(runtime.time)}" y2="${height}"/>`; $("waves").setAttribute("viewBox", `0 0 ${width} ${height}`); $("waves").innerHTML = out;
  }
  function zoomTime(factor, focus) { if (!runtime) return; const span = Math.max(1, Math.min(runtime.end, (windowEnd - windowStart) * factor)), center = Math.max(windowStart, Math.min(windowEnd, focus ?? runtime.time)); windowStart = Math.max(0, Math.min(runtime.end - span, center - span / 2)); windowEnd = windowStart + span; renderTimeline(); }
  function zoomCircuit(factor, px, py) { const box = svg.getBoundingClientRect(), fx = px === undefined ? .5 : (px - box.left) / box.width, fy = py === undefined ? .5 : (py - box.top) / box.height; const nextW = Math.max(150, Math.min(extent[2] * 2, viewBox[2] * factor)), nextH = viewBox[3] * nextW / viewBox[2]; viewBox = [viewBox[0] + fx * (viewBox[2] - nextW), viewBox[1] + fy * (viewBox[3] - nextH), nextW, nextH]; svg.setAttribute("viewBox", viewBox.join(" ")); }
  function handleCircuitClick(e) { const gesture = drag; drag = null; if (gesture?.moved) { renderCircuit(false); return; } const el = e.target.closest("[data-bundle],[data-net],[data-signal],[data-region],[data-blk],[data-cell],[data-device],[data-scope]"); if (!el) { if (gesture) renderCircuit(false); return; } if (el.dataset.bundle) { selectedBundle = el.dataset.bundle; const list = bundles.get(selectedBundle) || []; selectSignal(list.find(s => isSelected(s.bits)) || list[0]); } else if (el.dataset.net !== undefined) selectSignal(signalForNet(Number(el.dataset.net))); else if (el.dataset.signal) selectSignal(signalById.get(el.dataset.signal)); else if (el.dataset.region) changeView(el.dataset.region === "A" ? { kind: "blocks" } : { kind: "region", scope: el.dataset.region }); else if (el.dataset.blk !== undefined) changeView({ kind: "grid", blk: Number(el.dataset.blk), slot: 0 }); else if (el.dataset.cell) { const [term, bit] = el.dataset.cell.split(":").map(Number); changeView({ kind: "cell", blk: view.blk, slot: view.slot ?? 0, term, bit }); } else if (el.dataset.scope) changeView({ kind: "region", scope: el.dataset.scope }); else if (el.dataset.device !== undefined) { const d = devices[Number(el.dataset.device)]; selectSignal({ id: `device:${el.dataset.device}`, label: d.name, bits: d.outputs, device: Number(el.dataset.device) }); } }
  svg.addEventListener("click", handleCircuitClick); svg.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCircuitClick(e); } });
  svg.addEventListener("wheel", e => { e.preventDefault(); zoomCircuit(e.deltaY > 0 ? 1.12 : .89, e.clientX, e.clientY); }, { passive: false });
  svg.addEventListener("pointerdown", e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, box: viewBox.slice(), moved: false }; });
  svg.addEventListener("pointermove", e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 5) { drag.moved = true; svg.classList.add("dragging"); svg.setPointerCapture(e.pointerId); const bounds = svg.getBoundingClientRect(); viewBox = [drag.box[0] - dx / bounds.width * drag.box[2], drag.box[1] - dy / bounds.height * drag.box[3], drag.box[2], drag.box[3]]; svg.setAttribute("viewBox", viewBox.join(" ")); } });
  document.addEventListener("pointerup", e => {
    svg.classList.remove("dragging");
    // An inside release still needs its click target. An outside release cancels it.
    if (drag && !svg.contains(e.target)) { drag = null; renderCircuit(false); }
  });
  svg.addEventListener("pointercancel", () => { drag = null; svg.classList.remove("dragging"); renderCircuit(false); });
  $("breadcrumbs").addEventListener("click", e => { const el = e.target.closest("[data-view]"); if (!el) return; const k = el.dataset.view; if (k === "chip" || k === "blocks") changeView({ kind: k }); else if (k === "grid") changeView({ kind: "grid", blk: view.blk, slot: view.slot ?? 0 }); else if (k === "scope") changeView({ kind: "region", scope: el.dataset.scope }); });
  $("view-options").addEventListener("change", e => { if (e.target.id === "slot") { view.slot = Number(e.target.value); $("loc-slot").value = view.slot; renderCircuit(false); renderInspector(); } });
  $("view-options").addEventListener("click", e => { const b = e.target.closest("[data-open-scope]"); if (b) changeView({ kind: "region", scope: b.dataset.openScope }); });
  $("signal-list").addEventListener("click", handleCircuitClick); $("signal-search").addEventListener("input", renderInspector); $("signal-scope").onchange = renderInspector;
  $("play").onclick = () => { if (!runtime) return; if (playing) pause(); else { if (runtime.time >= runtime.end) seek(0); playing = true; previousTick = performance.now(); $("play").textContent = "Ⅱ Pause"; svg.unpauseAnimations?.(); } };
  $("prev-cycle").onclick = () => { pause(); if (runtime) { keepVisible(Math.max(0,runtime.time-runtime.period)); seek(runtime.time-runtime.period); } }; $("next-cycle").onclick = () => { pause(); if (runtime) { keepVisible(Math.min(runtime.end,runtime.time+runtime.period)); seek(runtime.time+runtime.period); } }; $("restart").onclick = () => { pause(); if (runtime) { keepVisible(0); seek(0); } }; $("prev-edge").onclick = () => stepEdge(-1); $("next-edge").onclick = () => stepEdge(1); $("prev-event").onclick = () => stepEvent(-1); $("next-event").onclick = () => stepEvent(1);
  $("seek").oninput = e => { pause(); seek(Number(e.target.value)); }; $("window-pan").oninput = e => { const span = windowEnd - windowStart; windowStart = Number(e.target.value); windowEnd = windowStart + span; renderTimeline(); };
  $("checkpoint").onchange = e => { if (e.target.value === "" || !runtime) return; pause(); const t = Number(e.target.value); keepVisible(t); seek(t); };
  $("time-in").onclick = () => zoomTime(.5); $("time-out").onclick = () => zoomTime(2); $("full-time").onclick = () => { if (runtime) { windowStart = 0; windowEnd = runtime.end; renderTimeline(); } }; $("focus-cycle").onclick = () => { if (runtime) { const span = Math.min(runtime.end, runtime.period * 3); windowStart = Math.max(0, Math.min(runtime.end - span, runtime.time - runtime.period)); windowEnd = windowStart + span; renderTimeline(); } };
  $("zoom-in").onclick = () => zoomCircuit(.75); $("zoom-out").onclick = () => zoomCircuit(1.333); $("fit").onclick = () => { viewBox = extent.slice(); svg.setAttribute("viewBox", viewBox.join(" ")); };
  $("watch-selected").onclick = addWatch; $("next-change").onclick = () => { pause(); if (!selected) return; for (let i = runtime.cursor; i < runtime.events.length; i++) { const next = runtime.events[i]; if (selected.bits.includes(next[1])) { keepVisible(next[0]); seek(next[0]); break; } } };
  $("watch-chips").addEventListener("click", e => {
    const remove = e.target.closest("[data-remove-watch]"), expand = e.target.closest("[data-expand-watch]");
    if (remove) watch.splice(Number(remove.dataset.removeWatch), 1);
    if (expand) { const s = watch[Number(expand.dataset.expandWatch)]; s.expanded = !s.expanded; }
    renderTimeline();
  });
  $("voltage").onchange = () => { watch.forEach(s => s.expanded = $("voltage").checked); renderTimeline(); };
  $("waves").addEventListener("pointerdown", e => { if (e.button !== 0 || !wavePosition(e).inPlot) return; e.preventDefault(); pause(); waveDrag = true; $("waves").setPointerCapture(e.pointerId); seek(wavePosition(e).time); });
  $("waves").addEventListener("pointermove", e => { showWaveHover(e); if (waveDrag) seek(wavePosition(e).time); });
  $("waves").addEventListener("pointerup", e => { waveDrag = false; if ($("waves").hasPointerCapture(e.pointerId)) $("waves").releasePointerCapture(e.pointerId); });
  $("waves").addEventListener("pointercancel", () => waveDrag = false);
  $("waves").addEventListener("pointerleave", () => $("wave-hover").hidden = true);
  $("waves").addEventListener("wheel", e => { if (!runtime) return; e.preventDefault();
    if (e.shiftKey) { const span = windowEnd - windowStart, start = Math.max(0, Math.min(runtime.end - span, windowStart + Math.sign(e.deltaY || e.deltaX) * span * .15)); setTimeWindow(start, start + span); }
    else zoomTime(e.deltaY > 0 ? 1.25 : .8, wavePosition(e).time);
  }, {passive: false});
  $("time-overview").addEventListener("pointerdown", e => {
    if (!runtime || e.button !== 0) return; e.preventDefault();
    const rect = $("time-overview").getBoundingClientRect();
    overviewDrag = {x: e.clientX, start: windowStart, end: windowEnd, width: rect.width, kind: e.target.id === "overview-left" ? "start" : e.target.id === "overview-right" ? "end" : e.target.closest("#overview-window") ? "move" : "center"};
    $("time-overview").setPointerCapture(e.pointerId);
    if (overviewDrag.kind === "center") { const span = windowEnd - windowStart, center = (e.clientX - rect.left) / rect.width * runtime.end, start = Math.max(0, Math.min(runtime.end - span, center - span / 2)); setTimeWindow(start, start + span); overviewDrag = {...overviewDrag, start:windowStart, end:windowEnd, kind:"move"}; }
  });
  $("time-overview").addEventListener("pointermove", e => {
    if (!overviewDrag) return; const d = overviewDrag, delta = (e.clientX - d.x) / d.width * runtime.end;
    if (d.kind === "start") setTimeWindow(Math.max(0, Math.min(d.end - 1, d.start + delta)), d.end);
    else if (d.kind === "end") setTimeWindow(d.start, Math.max(d.start + 1, Math.min(runtime.end, d.end + delta)));
    else { const span = d.end - d.start, start = Math.max(0, Math.min(runtime.end - span, d.start + delta)); setTimeWindow(start, start + span); }
  });
  for (const event of ["pointerup", "pointercancel"]) $("time-overview").addEventListener(event, () => overviewDrag = null);
  $("apply-window").onclick = () => { const ok = setTimeWindow($("window-start-ns").valueAsNumber * 1e6, $("window-end-ns").valueAsNumber * 1e6); $("window-error").textContent = ok ? "" : "Use 0 ≤ start < end ≤ trace end."; };
  $("chapters").onclick = e => { const button = e.target.closest("[data-step]"); if (!button) return; pause(); const p = data.checkpoints[Number(button.dataset.step)]; keepVisible(p.time_fs); seek(p.time_fs); };
  $("compare-clock").onchange = $("compare-edge").onchange = () => { comparisonAnchor = null; renderEdgeComparison(); };
  $("edge-comparison").onclick = e => { const action = e.target.closest("[data-edge-position]"); if (!action) return; const r = comparisonAnchor || FlexInspection.latestClockEdge(runtime,{clock:$("compare-clock").value,edge:$("compare-edge").value}); if (!r) return; pause(); comparisonAnchor = r; runtime.move(r.index + (action.dataset.edgePosition === "at" ? 1 : 0), r.time); keepVisible(r.time); refresh(); };
  $("bundle-signal").onchange = e => { const list = bundles.get(selectedBundle) || []; selectSignal(list[Number(e.target.value)]); };
  $("watch-bundle").onclick = () => { for (const s of bundles.get(selectedBundle) || []) if (!watch.some(w => sameBits(w.bits,s.bits))) watch.push({...s}); renderTimeline(); };
  $("cell-locator").onsubmit = e => { e.preventDefault(); openLocatedCell(); };
  $("cell-locator").addEventListener("click", e => { const b = e.target.closest("[data-cell-step]"); if (b) openLocatedCell(...b.dataset.cellStep.split(",").map(Number)); });
  svg.addEventListener("keydown", e => { const delta = {ArrowUp:[-1,0], ArrowDown:[1,0], ArrowLeft:[0,-1], ArrowRight:[0,1]}[e.key]; if (delta && view.kind === "cell") { e.preventDefault(); openLocatedCell(...delta); } });
  $("lesson-task").onchange = e => { lessonId = e.target.value; lessonBlk = null; renderLesson(); };
  $("lesson-blk").onchange = e => { lessonBlk = Number(e.target.value); renderLesson(); };
  $("lesson-start").onclick = () => { const l = FlexLessons.getLessonAt(lessons,runtime.time,lessonId === "auto" ? null : lessonId,runtime.cursor).lesson; if (l) { pause(); comparisonAnchor = null; runtime.move(l.start_event_index + 1,l.start_fs); keepVisible(l.start_fs); refresh(); } };
  $("lesson-body").onclick = e => { const b = e.target.closest("[data-sample-time]"); if (b) { pause(); comparisonAnchor = null; runtime.move(Number(b.dataset.sampleEvent),Number(b.dataset.sampleTime)); keepVisible(runtime.time); refresh(); } };
  $("help-open").onclick = () => $("help").showModal(); $("evidence-open").onclick = () => $("evidence").showModal(); document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => $(b.dataset.close).close());
  start(); requestAnimationFrame(animate);
})();
