// Smoke test: runs the finger example headless and prints joint angles and string tension for several winch pulls.
import { initPhysics, Sim } from '../src/physics.js';
import { fingerDemo } from '../src/demo.js';
await initPhysics();
const doc = fingerDemo();
const sim = new Sim(doc);
const sF = doc.strings[0].id, pins = doc.pins.filter(p=>p.type==='hinge');
for (const pull of [5,10,20,30,40,60,0]) {
  sim.setControls({ winch: { [sF]: pull } });
  const row=[];
  for (let i=0;i<5;i++){ sim.step(0.2); row.push(pins.map(p => sim.pinAngle(p.id).toFixed(0)).join('/')); }
  console.log('pull',pull,'L',(sim.tendonLength(sF)*1000).toFixed(1),'target',((sim.lengths[sF])*1000-pull).toFixed(1),'T',sim.tension(sF).toFixed(2), row.join('  '));
}
