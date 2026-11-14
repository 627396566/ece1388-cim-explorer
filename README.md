# FlexDCIM Circuit Explorer

**[Open the interactive explorer](https://627396566.github.io/ece1388-cim-explorer/)**

Follow the approved FlexDCIM-inspired digital CIM design from host bytes to stored
weights, bit-plane computation and delivered results. No school server is needed.
Use a current browser with gzip `DecompressionStream` support.

[Download the standalone offline HTML](https://627396566.github.io/ece1388-cim-explorer/downloads/FlexDCIM_Explorer_Offline.html)
(about 14 MB). Save it, then open the file in your browser. It contains all cases.

## Use the explorer

1. Select one of the eleven recorded cases, then select **Play**.
2. Open regions A–F while playback continues. Follow interface values and moving data.
3. In A, open a BLK and a DPU to inspect its SRAM slots and internal logic.
4. Select a wire to highlight its source, destinations and current value.
5. Use **What happens now**, clock-edge comparisons and gate calculations to follow a step.
6. Open a complete worked example to compare its arithmetic with recorded circuit values.
7. Add nodes to the waveform pane. Expand buses into individual logic-level traces.
8. Seek forward or backward, zoom the timeline, and step clock edges or gate events.

Powered but inactive BLKs appear gray. Powered-off BLKs have dark hatching.
Cases cover U1/U2/U4/U8, unequal input and weight precision, parallel BLKs,
pointwise mapping, padding, output backpressure, independent BLK power-off,
wake with weight reload, invalid input and reset recovery.

## Current architecture

- 16 BLKs, each with 64 terms, eight weight bits and eight weight slots: 64 Kb total.
- Unsigned inputs and weights, each from 1 to 8 bits. One task shares its input
  vector, precision pair and selected slot across all selected BLKs.
- 14-bit partial sums and a 22-bit final accumulator in region A.
- A single external clock. Separate PSUM capture and accumulator register stages.
- Two 8-bit host channels, a fixed five-byte command header, and three result bytes
  per selected BLK, in increasing BLK order.
- Independent whole-BLK power gating. Power-off loses that BLK's weights. Wake
  requires a new weight load before computation. A powered neighbor retains data.

This publication replaces the earlier Colonnade viewer. Its 1–16-bit signed
arithmetic, 128 × 128 cell layout and retention policy do not describe this design.
The [previous publication remains in Git history](https://github.com/627396566/ece1388-cim-explorer/tree/201cb10eaf8b2352358990b178406f8cc48ca859).

## Evidence boundary

The page replays recorded Python structural logic events. It does not replace
circuit values with arithmetic answers. The worked examples compare independent
arithmetic with those recorded events.

The 100 MHz stimulus, 20 ps gate delays and power-sequence waits are model
assumptions. TT, 0.8 V and 50 °C are nominal target labels, not transistor-model
parameters. The minimum physical target is U1 × U1 at 100 MHz, 0.8 V and 50 °C;
this viewer does not prove that target.

Digital 0/1/X/Z levels and the displayed 0/0.8 V traces are not measured voltages.
The model does not establish physical maximum frequency, power savings, safe
supply ramps, setup/hold closure, DRC, LVS or PEX acceptance. The topology count
is a count of modeled primitives, not transistors or mapped standard cells.

## Published files

`index.html`, `app.js`, `style.css`, `inspection.js` and `lessons.js` implement the
viewer. `manifest.json` lists cases and model assumptions. `topology.json.gz`
contains the shared hierarchy; case files contain recorded changes.
`site-manifest.json` records SHA-256 hashes of these files and the offline export.
This repository contains no foundry files, physical design databases, or original
calibration records.

Project members can use the [main project](https://github.com/627396566/ece1388-digital-cim),
[approved protocol](https://github.com/627396566/ece1388-digital-cim/blob/main/docs/flexdcim/protocol_v1_0.md)
and [module handoff](https://github.com/627396566/ece1388-digital-cim/blob/main/docs/flexdcim/modules/README.md).
The main project requires team access.

This is an independent paper-informed implementation, not an official FlexDCIM
paper artifact. No open-source license is granted.
