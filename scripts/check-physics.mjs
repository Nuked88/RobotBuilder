// Smoke test: runs both finger examples headless and prints joint angles and string tensions for several drum turns.
import { initPhysics, Sim } from '../src/physics.js';
import { fingerDemo, fingerBeltDemo } from '../src/demo.js';
await initPhysics();
for (const [name, make] of [['v1 elastici', fingerDemo], ['v2 cinghia', fingerBeltDemo]]) {
  const doc = make();
  const sim = new Sim(doc);
  if (sim.warnings.length) console.log(sim.warnings);
  const wid = doc.winches[0].id, pins = doc.pins.filter((p) => p.type === 'hinge');
  console.log('==', name);
  for (const turn of [0, 5, 10, 15, 20, 0]) {
    sim.setControls({ winch: { [wid]: turn } });
    sim.step(1.0);
    const T = doc.strings.map((s) => `${(s.name || s.id).slice(0, 14)}=${sim.tension(s.id).toFixed(2)}`).join(' ');
    console.log(`turn ${turn}mm angles ${pins.map((p) => sim.pinAngle(p.id).toFixed(1)).join('/')}  ${T}`);
  }
}
