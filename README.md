# Galaxy Walker Demo
<img width="1917" height="911" alt="Captura de pantalla 2026-02-03 024410" src="https://github.com/user-attachments/assets/87e6a33b-7e50-4add-a0af-84e784cf6b34" />

A single-file WebGL2 space + planet explorer: walk/fly around procedural planets, open a galaxy map, and **warp** to new star systems with atmospheres, clouds, oceans, and post effects. 
## Play
https://janders1800.github.io/Galaxy-Walker/

## Features
- **Procedural star system** generation (seeded) + rebuild on warp 
- **Planet terrain** using quadtree patches + skirts, distance culling, nearest-K LOD 
- **Oceans + waves**, underwater POST effect 
- **Log-depth atmospheres + clouds** (per planet), moons without atmo 
- **Galaxy sky dome** + **god rays** (cloud-occluded) 
- **Galaxy maps**: minimap + fullscreen map with star picking & warp
- **Warp sequence**: charge → countdown beeps → tunnel travel (unload/load) → fade out/in
- **Unified stardust**: asteroid belts (big + small) share the same stardust effect

## Controls
- **Click**: pointer lock / mouse look   
- **WASD** move • **Shift** boost • **Space** up/jump • **Ctrl** down   
- **F** take off • **L** land nearest • **R** respawn   
- **Q / E** roll (fly mode)   
- **M** toggle minimap • **+ / -** map zoom   
- **G** fullscreen galaxy map • **Esc / G** close   
- Fullscreen galaxy map: drag to pan • wheel to zoom • click to select • **double-click to warp** (fly mode only)   
- **P** toggle sun lights   

## Run it
Serve the folder with a local web server (ES modules/import maps don’t reliably work via file://):

```python3 -m http.server 8080```

Then open:

```http://localhost:8080/```

## Assets
Space ship by yanix.
https://sketchfab.com/3d-models/space-ship-356a3acb00164c698d657146caa5ebf3

## Tech
three.js.
