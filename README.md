[![make.fun · best-flight-game-20261126-0057](https://make.fun/badge/best-flight-game-20261126-0057.svg)](https://make.fun/bounty/best-flight-game-20261126-0057?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)
[![rank](https://make.fun/badge/best-flight-game-20261126-0057/tanakatsu33/cloudhaven-air-rally/rank.svg)](https://make.fun/bounty/best-flight-game-20261126-0057/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)
[![reward](https://make.fun/badge/best-flight-game-20261126-0057/tanakatsu33/cloudhaven-air-rally/reward.svg)](https://make.fun/bounty/best-flight-game-20261126-0057?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)

# Cloudhaven Air Rally

Cloudhaven Air Rally is an original 3D flight game that runs in the browser. Take off from the runway on Cloudhaven Island in the Kestrel K-1 bush plane and fly an 8-ring rally course over hills, beaches and sea. Watch your fuel: optional gold fuel rings top up the tank if you fly through them. Then bring the plane home for a landing that gets a rating. Everything is drawn and synthesised in code, with no image or audio assets.

## How to play

| Key | Action |
| --- | --- |
| Arrow Up / Down | Pitch (nose down / up) |
| Arrow Left / Right | Roll |
| W / S | Throttle up / down |
| A / D | Rudder left / right |
| B | Wheel brake |
| C | Switch camera (chase / cockpit) |
| P | Pause |
| R | Restart |
| M | Mute |
| Enter | Start |

## How it is built

Plain ES modules on a 2D canvas, with no dependencies or build step.

```
game/
  index.html          page shell and <canvas id="game">
  style.css           page styling
  src/
    main.js           entry point, screen state machine, game loop
    flight-model.js   deterministic aircraft physics
    island.js         island terrain, runway and world data
    mission.js        rally course, rings, fuel, landing rating
    renderer3d.js     software 3D renderer on a 2D canvas
    aircraft3d.js     3D model of the Kestrel K-1
    cockpit.js        cockpit view and live instrument panel
    hud.js            2D heads-up display
    input.js          keyboard and mouse input
    audio.js          procedural WebAudio engine, wind and effects
    shots.js          deterministic screenshot scenes (?shot=...)
```

## Run locally

```sh
node serve.ts
```

Then open http://localhost:8080 (Node 22 or later).
