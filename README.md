# Galaxy Walker Demo

A single-file WebGL2 space + planet explorer: walk/fly around procedural planets, open a galaxy map, and **warp** to new star systems with atmospheres, clouds, oceans, and post effects. 

## Features
- **Procedural star system** generation (seeded) + rebuild on warp 
- **Planet terrain** using quadtree patches + skirts, distance culling, nearest-K LOD 
- **Oceans + waves**, underwater POST effect 
- **Log-depth atmospheres + clouds** (per planet), moons without atmo 
- **Galaxy sky dome** + **god rays** (cloud-occluded) 
- **Galaxy maps**: minimap + fullscreen map with star picking & warp
- **Warp sequence**: charge → countdown beeps → tunnel travel (unload/load) → fade out/in 

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
Just open index.html, it should run localy.

## Tech
three.js.
