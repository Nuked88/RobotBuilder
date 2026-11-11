# RobotBuilder

Un banco di lavoro 3D "stile Lego Technic" per progettare meccanismi con fili e pulegge (per esempio mani robotiche a tendini) e vederli muovere con una vera simulazione fisica.

Si costruisce come coi mattoncini: clicchi una faccia e il pezzo ci si appoggia sopra, in qualsiasi direzione. Tutto sta su un reticolo di fori con passo di 8 mm: blocchi, travi forate, perni lisci (cerniera), perni a croce (bloccati), servo standard, pulegge, fili, elastici e verricelli. La fisica è [MuJoCo](https://mujoco.org) compilato in WebAssembly (`@mujoco/mujoco`, binding ufficiali DeepMind): l'editor genera un modello MJCF e lo simula direttamente nel browser.

## Come si usa

| Attrezzo | Tasto | Cosa fa |
|---|---|---|
| Mano | V, 1 | Seleziona e sposta; in simulazione trascina i pezzi. Frecce e Pag↑/Pag↓ spostano di un foro, R ruota, Ctrl+D duplica |
| Blocco | C, 2 | Clic su una faccia (pavimento, muro, un altro pezzo): il blocco ci si appoggia. Trascina per farlo lungo o a piastra, clic destro lo toglie |
| Trave | B, 3 | Clic su un foro, clic sul punto finale. La trave si stende sul piano della faccia cliccata e nasce imperniata al foro di partenza |
| Perno | P, 4 | Unisce il pezzo cliccato con quello dietro. Clic su un perno esistente per cambiarne il tipo |
| Servo | M, 5 | Scegli il modello e clicca un foro: il corpo si appoggia lì, l'albero esce verso di te. Quello che metti sull'albero gira con lui |
| Puleggia | U, 6 | Rinvio su cui il filo si avvolge |
| Filo | F, 7 | Clic in sequenza su fori, occhielli e pulegge (dal lato in cui deve passare). Se parte da un verricello è motorizzato |
| Verricello | W, 8 | Motore che tira un filo, comandato da uno slider. Può montare uno dei servo standard |
| Gomma | X, 9 | Toglie quello che clicchi |

Spazio avvia/mette in pausa la simulazione, Ctrl+Z annulla, tasto destro ruota la vista. I fili si colorano in base alla tensione e un filo lasco viene segnalato.

### Regole del gioco

- **I blocchi si incollano** a quello che toccano: altri blocchi, il muro, il pavimento, il corpo di un servo. Una spunta sul blocco toglie la colla, per i pezzi che devono muoversi accanto ad altri.
- **Le travi non si incollano**: si uniscono coi perni. Perno liscio = cerniera, perno a croce = bloccato.
- **Ogni blocco ha un foro su tutte le facce**: è il raccordo per passare da un piano all'altro (una trave contro il muro, una in piano, una di taglio).
- **Un servo fa girare ciò che sta sul suo albero**, trave o blocco, con la coppia, la velocità e la corsa del modello scelto.

### Servo in libreria

| Modello | Coppia | Velocità | Corsa | Peso |
|---|---|---|---|---|
| SG90 | 1,8 kg·cm | 0,10 s/60° | 180° | 9 g |
| MG90S | 2,2 kg·cm | 0,10 s/60° | 180° | 13 g |
| MG996R | 11 kg·cm | 0,14 s/60° | 180° | 55 g |
| DS3218 | 20 kg·cm | 0,16 s/60° | 270° | 60 g |
| DS3235 | 35 kg·cm | 0,13 s/60° | 270° | 60 g |

I dati stanno in `SERVO_MODELS` in `src/model.js`: per aggiungere un modello basta una riga.

## Sviluppo

```sh
npm install
npm run dev        # editor su http://localhost:5173
npm run check      # simulazione di prova degli esempi, senza browser
npm run build      # build statica in dist/
npm run artifact   # build per la pagina claude.ai (artifact/)
```

Struttura: `src/model.js` (documento, reticolo, libreria dei pezzi), `src/mjcf.js` (documento → MJCF), `src/physics.js` (MuJoCo WASM), `src/scene.js` (three.js), `src/app.js` (attrezzi e interfaccia), `src/storage.js` (salvataggio progetti).
