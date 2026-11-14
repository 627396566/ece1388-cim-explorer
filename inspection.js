/* Read-only teaching helpers. Recorded outputs always remain the trace truth.
 * compareAtEdge(runtime, bits, {clock, edge}) uses the last APPLIED clock event.
 * Its baseline is before that event, not one time unit before its timestamp.
 * explainDevice(device, runtime) computes targets only for combinational gates.
 * Storage explanations never replace recorded state with a calculated value.
 */
(function (root) {
  "use strict";
  const normal = value => value === 0 || value === "0" ? "0" : value === 1 || value === "1" ? "1" : value === "Z" ? "Z" : value === "?" ? "?" : "X";
  const indexOf = (runtime, net) => typeof net === "number" ? net : runtime.namesToIndex.get(net);
  const known = value => value === "0" || value === "1";
  const inv = value => value === "0" ? "1" : value === "1" ? "0" : "X";
  const and = values => values.includes("0") ? "0" : values.every(v => v === "1") ? "1" : "X";
  const or = values => values.includes("1") ? "1" : values.every(v => v === "0") ? "0" : "X";
  const mux = (s, a, b) => s === "1" ? a : s === "0" ? b : a === b ? a : "X";
  const histories = new WeakMap();
  function positions(runtime) {
    let entry = histories.get(runtime);
    if (!entry || entry.events !== runtime.events) {
      const nets = new Map();
      runtime.events.forEach((event, index) => {
        if (!nets.has(event[1])) nets.set(event[1], []);
        nets.get(event[1]).push(index);
      });
      entry = {events: runtime.events, nets}; histories.set(runtime, entry);
    }
    return entry.nets;
  }
  function countBefore(indices, cursor) {
    let low = 0, high = indices.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (indices[mid] < cursor) low = mid + 1; else high = mid;
    }
    return low;
  }
  function valueBeforeEvent(runtime, net, cursor) {
    const index = indexOf(runtime, net);
    if (!Number.isInteger(index) || index < 0 || index >= runtime.names.length) return "?";
    const indices = positions(runtime).get(index) || [];
    const count = countBefore(indices, cursor);
    return normal(count ? runtime.events[indices[count - 1]][2] : runtime.initial[index]);
  }
  function latestClockEdge(runtime, {clock = "F.clk_root", edge = "both"} = {}) {
    if (!["both", "rising", "falling"].includes(edge)) throw new Error(`Unknown clock edge selector: ${edge}`);
    const clockIndex = indexOf(runtime, clock);
    if (!Number.isInteger(clockIndex)) return null;
    const indices = positions(runtime).get(clockIndex) || [];
    for (let p = countBefore(indices, runtime.cursor) - 1; p >= 0; p--) {
      const index = indices[p], event = runtime.events[index];
      const before = normal(p ? runtime.events[indices[p - 1]][2] : runtime.initial[clockIndex]);
      const after = normal(event[2]);
      const direction = before === "0" && after === "1" ? "rising" : before === "1" && after === "0" ? "falling" : null;
      if (direction && (edge === "both" || edge === direction)) {
        return {clock: runtime.names[clockIndex], clockIndex, index, cursor: index, time: event[0], edge: direction, from: before, to: after};
      }
    }
    return null;
  }
  function word(values) {
    if (!values.length || values.includes("?")) return "Untraced";
    if (values.every(v => v === "Z")) return "Z";
    if (!values.every(known)) return "X";
    return values.reduce((value, bit, i) => value | (BigInt(bit) << BigInt(i)), 0n).toString();
  }
  function compareAtEdge(runtime, bits, options = {}) {
    const reference = latestClockEdge(runtime, options);
    const rows = bits.map(net => {
      const index = indexOf(runtime, net), current = runtime.value(index);
      const before = reference ? valueBeforeEvent(runtime, index, reference.index) : null;
      return {index, name: runtime.names[index] || String(net), before, current, changed: reference ? before !== current : null};
    });
    const beforeValues = rows.map(row => row.before), currentValues = rows.map(row => row.current);
    return {reference, rows, beforeValues, currentValues,
      beforeWord: reference ? word(beforeValues) : "No earlier edge", currentWord: word(currentValues)};
  }
  function clockChoices(runtime) {
    const locals = runtime.names.filter(name => /^B\.local\d+\.clock_gate\.out$/.test(name))
      .sort((a, b) => Number(/local(\d+)/.exec(a)[1]) - Number(/local(\d+)/.exec(b)[1]));
    return ["F.clk", "F.clk_root", ...locals].filter(name => runtime.namesToIndex.has(name)).map(name => ({
      name, label: name === "F.clk" ? "Source clock" : name === "F.clk_root" ? "Buffered root clock" : `BLK ${/local(\d+)/.exec(name)[1]} local clock`,
    }));
  }
  function roles(device) {
    const kinds = {INV: ["A"], BUF: ["A"], MUX: ["Select", "D1", "D0"],
      TRISTATE_DRIVER: ["Enable", "Data"], POWERED_VIEW: ["Power", "Tree on", "Data"],
      TG_LATCH: ["D", "Enable"], TRISTATE_LATCH: ["D", "Enable"],
      SRAM_STATE: ["WL", "BL", "BLB", "Power"],
      DYNAMIC_BLX: ["EN", "Discharge", "Power"], DYNAMIC_BLI: ["EN", "WS", "BLX", "Power"],
      DYNAMIC_CBL: ["EN", "BLI", "Power"]};
    if (device.kind === "DFF") return ["D", "CLK", "Reset_n", ...(device.power_behavior ? ["Power"] : [])];
    return kinds[device.kind] || device.inputs.map((_, i) => `Input ${i}`);
  }
  function explainDevice(device, runtime) {
    const pinRoles = roles(device);
    const inputs = device.inputs.map((net, i) => {
      const index = indexOf(runtime, net);
      return {index, name: runtime.names[index] || String(net), role: pinRoles[i] || `Input ${i}`, value: runtime.value(index)};
    });
    const outputs = device.outputs.map(net => {
      const index = indexOf(runtime, net);
      return {index, name: runtime.names[index] || String(net), value: runtime.value(index)};
    });
    const v = inputs.map(pin => pin.value), kind = device.kind;
    const result = {kind, category: "unmodeled", inputs, outputs, observed: outputs.length === 1 ? outputs[0].value : word(outputs.map(p => p.value)),
      target: null, mismatch: null, status: "unmodeled", lines: [], delayFs: device.delay_fs ?? null, sample: null};
    const target = {
      INV: () => inv(v[0]), BUF: () => v[0], AND: () => and(v), OR: () => or(v),
      NAND: () => inv(and(v)), NOR: () => inv(or(v)),
      XOR: () => v.every(known) ? String(Number(v[0]) ^ Number(v[1])) : "X",
      XNOR: () => inv(v.every(known) ? String(Number(v[0]) ^ Number(v[1])) : "X"),
      MUX: () => mux(v[0], v[1], v[2]),
      TRISTATE_DRIVER: () => v[0] === "1" ? v[1] : v[0] === "0" ? "Z" : "X",
      POWERED_VIEW: () => v[0] === "1" && v[1] === "1" ? v[2] : "X",
    }[kind];
    if (target) {
      result.category = "combinational"; result.target = target();
      result.mismatch = result.target !== result.observed;
      result.status = result.mismatch ? "different" : "matches";
      const formula = kind === "MUX" ? `Select=${v[0]} chooses D1=${v[1]} when 1, D0=${v[2]} when 0. An unknown select preserves equal branch values.`
        : kind === "TRISTATE_DRIVER" ? `Enable=${v[0]}. Enabled: pass Data=${v[1]}; disabled: high impedance Z; unknown enable: X.`
        : kind === "POWERED_VIEW" ? `Power=${v[0]}, tree_on=${v[1]}. Data=${v[2]} is visible only when both controls are 1; otherwise this model outputs X, not an isolation zero.`
        : `${kind}(${v.join(", ")}) = ${result.target}.${["AND", "NAND", "OR", "NOR"].includes(kind) ? " AND with 0 and OR with 1 resolve despite other unknown inputs." : ""}`;
      result.lines.push(formula, `Combinational target from current inputs: ${result.target}. Recorded output: ${result.observed}.`);
      if (result.mismatch) result.lines.push("The values differ at this cursor. Inertial gate delay can leave the recorded output behind its current target. This comparison alone does not prove a circuit fault.");
      result.lines.push("The target is a teaching calculation, not a replacement trace value or a prediction of the next committed event.");
    } else if (kind === "DFF") {
      result.category = "storage";
      const power = device.power_behavior ? v[3] : "1", reset = v.length >= 3 ? v[2] : null;
      result.status = power !== "1" ? "power_invalid" : reset === "0" ? "reset" : "edge_storage";
      result.lines.push(`D=${v[0]}, CLK=${v[1]}, recorded Q=${result.observed}. This register samples D on a known 0→1 clock transition. D may differ from Q between edges.`);
      if (power !== "1") result.lines.push("The switched supply is not known on. This model invalidates Q and does not accept clock samples while power is not 1.");
      else if (reset === "0") result.lines.push("Active-low reset is asserted. The model applies the configured asynchronous reset value; that value is not included in the exported DFF metadata.");
      else if (reset !== null && reset !== "1") result.lines.push("Reset is unknown. This digital kernel only asserts reset at 0; it does not model analog reset release or metastability.");
      const reference = latestClockEdge(runtime, {clock: inputs[1]?.index, edge: "rising"});
      if (reference) {
        result.sample = {reference, data: valueBeforeEvent(runtime, inputs[0].index, reference.index),
          reset: reset === null ? null : valueBeforeEvent(runtime, inputs[2].index, reference.index),
          power: device.power_behavior ? valueBeforeEvent(runtime, inputs[3].index, reference.index) : null};
        result.lines.push(`At the last applied rising clock edge (${reference.time} fs), D immediately before the edge was ${result.sample.data}. Clock-to-Q delay and later reset or power events determine the observed Q.`);
      } else result.lines.push("No known rising transition of this register's clock has been applied at this cursor.");
      result.lines.push("Clock enable, when present, is a separate feedback MUX on D. The viewer does not infer a new clock or an unrecorded enable pin.");
    } else if (kind === "TG_LATCH" || kind === "TRISTATE_LATCH") {
      result.category = "storage";
      const active = device.active === 0 || device.active === 1 ? String(device.active) : null;
      const transparent = active !== null && v[1] === active;
      result.status = !known(v[1]) || active === null ? "unknown_control" : transparent ? "transparent" : "holding";
      result.lines.push(`Recorded Q=${result.observed}. The latch is transparent when Enable=${active ?? "the unrecorded active level"}. It stores state when closed; it does not wait for a clock edge.`);
      result.lines.push(transparent ? `The open latch follows ${device.invert ? "inverted " : ""}D=${v[0]} after its storage delay. A closing enable cancels a pending input update.`
        : result.status === "holding" ? "The latch is closed. Current D does not determine the stored Q." : "Enable or its active level is unknown. The model makes the latch state unknown for an unknown enable; the viewer does not infer a stored bit.");
    } else if (kind === "SRAM_STATE") {
      result.category = "storage";
      result.status = v[3] !== "1" ? "power_invalid" : v[0] === "0" ? "holding" : v[0] === "1" ? "writing" : "unknown_control";
      result.lines.push(`WL=${v[0]}, BL=${v[1]}, BLB=${v[2]}, Power=${v[3]}; recorded Q=${result.observed}.`);
      if (v[3] !== "1") result.lines.push("Power is not known on. The SRAM state is invalidated in this model. Power restoration does not restore the old weight.");
      else if (v[0] === "0") result.lines.push("WL is low. The SRAM holds its recorded state regardless of the current BL/BLB values.");
      else if (v[0] === "1") result.lines.push(known(v[1]) && v[2] === inv(v[1])
        ? `WL is high and the write bitlines are complementary. The storage model writes BL=${v[1]} after its delay.`
        : "WL is high, but BL/BLB are not a known complementary pair. This write makes the modeled stored state X.");
      else result.lines.push("WL is unknown. The storage model schedules an unknown state.");
      result.lines.push("This cell has no reset pin. Global or local reset does not directly clear its stored weight; supply loss does.");
    } else if (["DYNAMIC_BLX", "DYNAMIC_BLI", "DYNAMIC_CBL"].includes(kind)) {
      result.category = "dynamic_storage";
      const power = v.at(-1), phase = v[0];
      result.status = power !== "1" ? "power_invalid" : phase === "0" ? (kind === "DYNAMIC_CBL" ? "holding" : "precharge") : phase === "1" ? "evaluate" : "unknown_control";
      result.lines.push(`Recorded ${kind.slice(8)}=${result.observed}. This is stateful charge storage in a digital abstraction, not an ordinary combinational gate.`);
      if (power !== "1") result.lines.push("Power is not known on. The model invalidates the dynamic node.");
      else if (phase === "0") result.lines.push(kind === "DYNAMIC_CBL"
        ? "EN is low. CBL holds its stored value while the upstream BLX and BLI nodes precharge."
        : "EN is low. This node precharges toward logic 1 after the storage delay.");
      else if (phase === "1") {
        if (kind === "DYNAMIC_BLX") result.lines.push(v[1] === "1" ? "EN is high and discharge is 1: BLX can discharge to 0. It does not recharge until precharge."
          : v[1] === "0" ? "EN is high and discharge is 0: BLX holds its previous charge; it is not forced back to 1."
          : "Discharge is unknown. The kernel applies MUX(discharge, 0, stored BLX); an already-low node remains low, otherwise the result can be X.");
        if (kind === "DYNAMIC_BLI") result.lines.push(`EN is high. The kernel applies MUX(WS=${v[1]}, stored BLI AND BLX=${v[2]}, stored BLI). A selected low BLX can discharge BLI; an unselected BLI holds its state.`);
        if (kind === "DYNAMIC_CBL") result.lines.push(`EN is high. CBL follows the inverse of BLI=${v[1]} after its storage delay.`);
      } else result.lines.push(kind === "DYNAMIC_CBL" ? "EN is unknown. The kernel uses MUX(EN, NOT BLI, stored CBL); equal branches can preserve a value." : "EN is unknown. This dynamic-node model schedules X.");
      result.lines.push("The model uses ideal stored logic. It does not establish analog voltage, leakage, charge sharing, or physical retention time.");
    } else result.lines.push("This device kind has no checked explanation here. Read the recorded inputs and outputs; no truth function or storage value is inferred.");
    return result;
  }
  const api = {clockChoices, latestClockEdge, valueBeforeEvent, compareAtEdge, explainDevice};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FlexInspection = api;
})(globalThis);
