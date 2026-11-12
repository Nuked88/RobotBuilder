// Smoke test: runs both finger examples headless and prints joint angles and string tensions for several drum turns.
import { initPhysics, Sim } from '../src/physics.js';
import { fingerDemo, fingerBeltDemo, armDemo } from '../src/demo.js';
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

// The arm built in space: both servos must reach where they are sent, at their own speed.
{
  const doc = armDemo();
  const sim = new Sim(doc);
  if (sim.warnings.length) console.log(sim.warnings);
  const [base, shoulder] = doc.parts.filter((p) => p.type === 'servo');
  console.log('== braccio con due servo');
  for (const [a, b] of [[0, 0], [60, 0], [60, 45], [-90, -45], [0, 0]]) {
    sim.setControls({ servo: { [base.id]: a, [shoulder.id]: b } });
    sim.step(0.1);
    const early = `${sim.pinAngle(base.id).toFixed(1)}/${sim.pinAngle(shoulder.id).toFixed(1)}`;
    for (let i = 0; i < 9; i++) sim.step(0.1);
    console.log(`target ${a}/${b}  after 0.1 s ${early}  after 1 s ${sim.pinAngle(base.id).toFixed(1)}/${sim.pinAngle(shoulder.id).toFixed(1)}  torque ${(sim.servoTorque(base.id) * 100).toFixed(1)}/${(sim.servoTorque(shoulder.id) * 100).toFixed(1)} N·cm`);
  }
}
