const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

let pokemonData = null;
let displayOrder = [];
let coopRevealed = new Set();
let coopMembers = {}; // Track which user found which Pokemon
let lastDiscovery = null; // { userName, pokemonName, timestamp }
let elapsedMs = 0;
let paused = false;
let timerInterval = null;
let clients = new Set();

const REGION_GEN = {
  'Kanto': 1, 'Johto': 2, 'Hoenn': 3, 'Sinnoh': 4,
  'Unova': 5, 'Kalos': 6, 'Alola': 7, 'Galar': 8, 'Paldea': 9
};

const defaultSettings = {
  shadows: false,
  orderMode: 'dex-gens',
  timerMs: 0,
  gens: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9])
};

let coopSettings = { ...defaultSettings, gens: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]) };

app.use(express.json());

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin/reset', (req, res) => {
  console.log('Game reset initiated (GET)');
  resetGame();
  res.json({ status: 'ok', message: 'Game reset' });
});

app.post('/admin/reset', (req, res) => {
  console.log('Game reset initiated');
  resetGame();
  res.json({ status: 'ok', message: 'Game reset' });
});

app.post('/admin/assign', (req, res) => {
  const { name, pokemon } = req.body;
  
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ status: 'error', message: 'Missing or invalid "name" field' });
  }
  
  if (!Array.isArray(pokemon) || pokemon.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Missing or invalid "pokemon" field' });
  }
  
  if (!pokemonData || displayOrder.length === 0) {
    return res.status(400).json({ status: 'error', message: 'No pokemon data loaded' });
  }
  
  const items = filterByGens(pokemonData, coopSettings.gens);
  let assignedCount = 0;
  
  for (const pokeName of pokemon) {
    const pokeNameLower = pokeName.toLowerCase().trim();
    
    // Find pokemon by exact name (case-insensitive)
    let foundIdx = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].n.toLowerCase() === pokeNameLower) {
        foundIdx = i;
        break;
      }
    }
    
    if (foundIdx === -1) {
      console.log(`Pokemon not found: ${pokeName}`);
      continue;
    }
    
    const pokemonId = items[foundIdx].id;
    const actualIdx = displayOrder[foundIdx];
    
    // Remove from any existing discoverer (transfer ownership)
    for (const memberName in coopMembers) {
      const idx = coopMembers[memberName].indexOf(pokemonId);
      if (idx !== -1) {
        coopMembers[memberName].splice(idx, 1);
        console.log(`Transferred ${pokeName} from ${memberName} to ${name}`);
      }
    }
    
    // Add to new member
    if (!coopMembers[name]) {
      coopMembers[name] = [];
    }
    if (!coopMembers[name].includes(pokemonId)) {
      coopMembers[name].push(pokemonId);
    }
    
    // Mark as revealed
    coopRevealed.add(actualIdx);
    assignedCount++;
  }
  
  // Broadcast state to all clients
  broadcastState();
  
  res.json({ status: 'ok', assigned: assignedCount });
});

app.get('/admin/assign', (req, res) => {
  const members = [];
  
  for (const [name, pokemonIds] of Object.entries(coopMembers)) {
    const items = filterByGens(pokemonData, coopSettings.gens);
    const pokemonNames = pokemonIds
      .map(id => {
        const poke = items.find(p => p.id === id);
        return poke ? poke.n : null;
      })
      .filter(n => n);
    
    if (pokemonNames.length > 0) {
      members.push({ name, pokemon: pokemonNames });
    }
  }
  
  res.json({ members });
});

function resetGame() {
   coopRevealed = new Set();
   coopMembers = {}; // Reset member tracking
   elapsedMs = 0;
   paused = false;
   
   if (timerInterval) {
     clearInterval(timerInterval);
     timerInterval = null;
   }
   
   if (pokemonData) {
     const items = filterByGens(pokemonData, coopSettings.gens);
     displayOrder = items.map((_, i) => i);
     
     if (coopSettings.orderMode === 'random') {
       for (let i = displayOrder.length - 1; i > 0; i--) {
         const j = Math.floor(Math.random() * (i + 1));
         [displayOrder[i], displayOrder[j]] = [displayOrder[j], displayOrder[i]];
       }
     }
   }
   
   broadcastState();
 }

function filterByGens(data, gens) {
  return data.filter(p => p.g && REGION_GEN[p.g] && gens.has(REGION_GEN[p.g]));
}

function loadPokemonData() {
  const filePath = path.join(__dirname, 'pokemon.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    pokemonData = JSON.parse(raw);
    
    const items = filterByGens(pokemonData, coopSettings.gens);
    displayOrder = items.map((_, i) => i);
    
    console.log(`Loaded ${pokemonData.length} Pokémon, ${items.length} in scope`);
  } catch (err) {
    console.error('Failed to load pokemon.json:', err.message);
  }
}

function broadcastState() {
   const state = {
     type: 'sync',
     displayOrder: displayOrder,
     settings: {
       shadows: coopSettings.shadows,
       orderMode: coopSettings.orderMode,
       timerMs: coopSettings.timerMs,
       gens: Array.from(coopSettings.gens)
     },
     coopRevealed: Array.from(coopRevealed),
     coopMembers: coopMembers,
     lastDiscovery: lastDiscovery,
     elapsedMs: elapsedMs,
     paused: paused
   };
   
   const msg = JSON.stringify(state);
   clients.forEach(client => {
     if (client.readyState === WebSocket.OPEN) {
       client.send(msg);
     }
   });
 }

function broadcastReveal(indices) {
   const msg = JSON.stringify({ type: 'reveal', indices: Array.from(indices) });
   clients.forEach(client => {
     if (client.readyState === WebSocket.OPEN) {
       client.send(msg);
     }
   });
 }

function broadcastRevealWithUser(indices, userName, pokemonName) {
   const msg = JSON.stringify({ type: 'reveal', indices: Array.from(indices), userName: userName, pokemonName: pokemonName });
   clients.forEach(client => {
     if (client.readyState === WebSocket.OPEN) {
       client.send(msg);
     }
   });
}

function broadcastPause(isPaused) {
  const msg = JSON.stringify({ type: isPaused ? 'pause' : 'resume' });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function broadcastEnd() {
  const msg = JSON.stringify({ type: 'end' });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function findMatchingPokemon(input) {
  if (!pokemonData || displayOrder.length === 0) return [];
  
  const query = input.toLowerCase().trim();
  const items = filterByGens(pokemonData, coopSettings.gens);
  const matches = [];
  
  for (const idx of displayOrder) {
    if (coopRevealed.has(idx)) continue;
    
    const poke = items[idx];
    if (!poke || !poke.n) continue;
    
    const name = poke.n.toLowerCase();
    const nameMatches = name.includes(query);
    
    let altMatches = false;
    if (poke.a && Array.isArray(poke.a)) {
      altMatches = poke.a.some(a => a.toLowerCase().includes(query));
    }
    
    let formMatches = false;
    if (poke.f && Array.isArray(poke.f)) {
      formMatches = poke.f.some(f => f.toLowerCase().includes(query));
    }
    
    if (nameMatches || altMatches || formMatches) {
      matches.push(idx);
    }
  }
  
  return matches;
}

function startTimer() {
  if (timerInterval) return;
  
  timerInterval = setInterval(() => {
    if (!paused) {
      elapsedMs += 100;
    }
  }, 100);
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.add(ws);
  
  if (pokemonData && displayOrder.length > 0) {
    const initMsg = JSON.stringify({
      type: 'init',
      displayOrder: displayOrder,
      settings: {
        shadows: coopSettings.shadows,
        orderMode: coopSettings.orderMode,
        timerMs: coopSettings.timerMs,
        gens: Array.from(coopSettings.gens)
      },
      coopRevealed: Array.from(coopRevealed),
      coopMembers: coopMembers,
      lastDiscovery: lastDiscovery,
      elapsedMs: elapsedMs,
      paused: paused
    });
    ws.send(initMsg);
    
    if (!timerInterval && !paused) {
      startTimer();
    }
  }
  
   ws.on('message', (data) => {
     try {
       const msg = JSON.parse(data);
       
       if (msg.type === 'guess') {
         const matches = findMatchingPokemon(msg.input);
         
         if (matches.length > 0) {
           const newReveals = new Set();
           
           for (const displayIdx of matches) {
             const actualIdx = displayOrder[displayIdx];
             if (!coopRevealed.has(actualIdx)) {
               coopRevealed.add(actualIdx);
               newReveals.add(actualIdx);
               
               // Track which user found this Pokemon
               if (msg.userName) {
                 if (!coopMembers[msg.userName]) {
                   coopMembers[msg.userName] = [];
                 }
                 const items = filterByGens(pokemonData, coopSettings.gens);
                 const pokemonId = items[actualIdx].id;
                 coopMembers[msg.userName].push(pokemonId);
               }
             }
           }
           
              if (newReveals.size > 0) {
               // Broadcast reveal with user attribution
               const items = filterByGens(pokemonData, coopSettings.gens);
               const lastIdx = Array.from(newReveals).pop();
               const lastPokeName = items[lastIdx]?.n || 'Unknown';
               lastDiscovery = { userName: msg.userName || 'Anonymous', pokemonName: lastPokeName, timestamp: Date.now() };
               broadcastRevealWithUser(newReveals, msg.userName || 'Anonymous', lastPokeName);
               
               if (coopRevealed.size === items.length) {
               if (timerInterval) {
                 clearInterval(timerInterval);
                 timerInterval = null;
               }
               broadcastEnd();
             }
           }
         }
       } else if (msg.type === 'pause') {
        paused = true;
        broadcastPause(true);
      } else if (msg.type === 'resume') {
        paused = false;
        broadcastPause(false);
      } else if (msg.type === 'finish') {
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
        broadcastEnd();
      }
     } catch (err) {
       console.error('Message error:', err.message);
     }
   });
  
  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });
});

loadPokemonData();

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});