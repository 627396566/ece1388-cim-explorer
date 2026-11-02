# CIM Chip Explorer

**[Open the interactive chip explorer](https://627396566.github.io/ece1388-cim-explorer/)**

Explore a 128 × 128 digital compute-in-memory bank in your browser. No installation or school server is required. Use a current browser with gzip `DecompressionStream` support; Chrome is used for the browser checks.

## Use the explorer

1. Select one of the 14 recorded cases, then select **Play**.
2. Open a module to follow its interfaces, wires, and current values.
3. Open region A to inspect the 128 × 128 cells. Zoom and pan, then double-click a cell to inspect its SRAM and logic gates.
4. Select a wire to highlight its source, destination, and value.
5. Add signals to the waveform pane. Expand a bus to see its individual bits.
6. Move the time cursor forward or backward. Zoom in to inspect changes between clock edges.

Cases include 1-, 2-, 4-, 8-, and 16-bit operation, unequal input and weight precision, parallel output groups, Pointwise tasks, padding, backpressure, accumulation, shallow sleep, deep sleep, and recovery.

## Model boundary

The page replays recorded Python structural gate-network events. It preserves the signal values and event times. Internal gate delays are illustrative. Digital 0/1/X/Z levels are not analog voltages. The viewer does not prove physical maximum frequency, power, or layout timing closure.

A task may use different input and weight precisions. All selected groups in one task share those precisions. The model accepts one task at a time.

## Published files

`index.html` contains the interface and replay code. Compressed traces in `assets/` load only when their case is selected. `site-manifest.json` records the file hashes. This repository contains the web viewer and its recorded teaching data. The physical design, foundry files, and original calibration files are not distributed here.

For project members: [main CIM project](https://github.com/627396566/ece1388-digital-cim).

The design is independently developed and informed by Colonnade. This is not an official paper artifact. No open-source license is granted.
