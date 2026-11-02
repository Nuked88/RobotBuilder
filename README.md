# RobotBuilder

Un banco di lavoro 3D "stile Lego Technic" per progettare meccanismi con fili e pulegge (per esempio mani robotiche a tendini) e vederli muovere con una vera simulazione fisica.

Tutto si aggancia a fori con passo di 8 mm: travi forate, perni lisci (cerniera), perni a croce (bloccati), servo, pulegge, fili, elastici e verricelli. La fisica è [MuJoCo](https://mujoco.org) compilato in WebAssembly (`@mujoco/mujoco`, binding ufficiali DeepMind): l'editor genera un modello MJCF e lo simula direttamente nel browser.

## Come si usa

| Attrezzo | Tasto | Cosa fa |
|---|---|---|
| Mano | V | Seleziona e modifica; in simulazione trascina i pezzi |
| Trave | B | Clic su un foro, clic sul punto finale. Continua a cliccare per aggiungere falangi: ogni trave nasce imperniata alla precedente |
| Perno | P | Unisce il pezzo cliccato con quello dietro. Clic su un perno esistente per cambiarne il tipo |
| Puleggia | U | Rinvio su cui il filo si avvolge |
| Filo | F | Clic in sequenza su fori e pulegge (dal lato in cui deve passare). Se parte da un verricello è motorizzato |
| Verricello | W | Motore che tira un filo, comandato da uno slider |
| Gomma | X | Toglie quello che clicchi |

Spazio avvia/mette in pausa la simulazione, Ctrl+Z annulla, tasto destro ruota la vista. I fili si colorano in base alla tensione e un filo lasco viene segnalato.

## Sviluppo

```sh
npm install
npm run dev        # editor su http://localhost:5173
npm run check      # simulazione di prova del dito d'esempio, senza browser
npm run build      # build statica in dist/
npm run artifact   # build per la pagina claude.ai (artifact/)
```

Struttura: `src/model.js` (documento e geometria dei fori), `src/mjcf.js` (documento → MJCF), `src/physics.js` (MuJoCo WASM), `src/scene.js` (three.js), `src/app.js` (attrezzi e interfaccia), `src/storage.js` (salvataggio progetti).
