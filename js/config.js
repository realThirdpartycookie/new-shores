'use strict';
/* ============================================================
 * New Shores — game definitions
 * A browser homage to the classic island city-builders.
 * ============================================================ */

// Tile types
const TILE = { DEEP: 0, WATER: 1, SAND: 2, GRASS: 3, TREE: 4, ROCK: 5 };

// Isometric tile metrics (pixels at zoom 1)
const TW = 64, TH = 32, TW2 = 32, TH2 = 16;

// Map size (tiles) — big enough for an archipelago
const MAPW = 96, MAPH = 96;

// Crops that depend on island fertility (building key = crop key)
const FERTILITY_CROPS = ['sheep', 'grain', 'potato'];

// Storage
const STORAGE_BASE = 300;
const STORAGE_PER_DEPOT = 150;

// Goods that occupy warehouse space (gold is unlimited)
const GOODS = ['wood', 'tools', 'iron', 'food', 'grain', 'wool', 'cloth', 'potato', 'liquor'];

const RES_META = {
  gold:   { name: 'Gold',     icon: '🪙' },
  wood:   { name: 'Wood',     icon: '🪵' },
  tools:  { name: 'Tools',    icon: '🔨' },
  iron:   { name: 'Iron',     icon: '⚙️' },
  food:   { name: 'Food',     icon: '🐟' },
  grain:  { name: 'Grain',    icon: '🌾' },
  wool:   { name: 'Wool',     icon: '🐑' },
  cloth:  { name: 'Cloth',    icon: '🧵' },
  potato: { name: 'Potatoes', icon: '🥔' },
  liquor: { name: 'Liquor',   icon: '🥃' },
};

// Trading ship prices
const TRADE = {
  wood:   { buy: 10, sell: 4 },
  tools:  { buy: 35, sell: 14 },
  iron:   { buy: 25, sell: 10 },
  food:   { buy: 6,  sell: 2 },
  grain:  { buy: 8,  sell: 3 },
  wool:   { buy: 14, sell: 5 },
  cloth:  { buy: 24, sell: 10 },
  potato: { buy: 9,  sell: 3 },
  liquor: { buy: 30, sell: 13 },
};

/* Population tiers.
 * goods: per-resident consumption in units per MINUTE.
 * services: service types that must cover the house.
 * upgrade: paid automatically when the house is full, the next tier is
 *          unlocked, next-tier services are covered and needsGood is in stock. */
const TIERS = [
  {
    key: 'pioneer', name: 'Pioneers', resMax: 8, tax: 0.02,
    goods: { food: 0.9 },
    services: ['market'],
    upgrade: { cost: { gold: 120, wood: 8, tools: 2 }, needsGood: 'cloth' },
  },
  {
    key: 'settler', name: 'Settlers', resMax: 15, tax: 0.04,
    goods: { food: 1.0, cloth: 0.4 },
    services: ['market', 'faith'],
    upgrade: { cost: { gold: 300, wood: 15, tools: 5 }, needsGood: 'liquor' },
  },
  {
    key: 'citizen', name: 'Citizens', resMax: 25, tax: 0.07,
    goods: { food: 1.1, cloth: 0.5, liquor: 0.4 },
    services: ['market', 'faith', 'fun'],
    upgrade: null,
  },
];

// Tier unlock requirements: tier i+1 unlocks when popOf(i) >= count
const UNLOCKS = [
  null,
  { tier: 0, count: 24, label: 'Pioneers' },
  { tier: 1, count: 30, label: 'Settlers' },
];

const SERVICE_NAMES = { market: 'Marketplace', faith: 'Chapel', fun: 'Tavern' };

const ROAD_COST = 2; // gold per tile
const GROW_INTERVAL = 5;    // seconds between house growth steps
const COND_INTERVAL = 2;    // seconds between nature-condition rechecks

/* Building catalogue.
 * size: footprint (size x size tiles)
 * needsRoad: must connect via roads to the Warehouse / a Depot
 * zone: extends the buildable area by this radius
 * service + radius: covers houses within radius
 * prod: { out, n, cycle, in? } produce n of `out` every `cycle` seconds
 * req: nature requirement — trees / coast / rock / pasture */
const BUILDINGS = {
  warehouse: {
    name: 'Warehouse', icon: '🏰', size: 2, tier: 1, cost: {}, buildable: false,
    buildTime: 0, zone: 16,
    desc: 'Your island Kontor. All goods are stored here; roads must lead back to it.',
  },
  house: {
    name: 'House', icon: '🏠', size: 1, tier: 1, cost: { gold: 30, wood: 3 },
    buildTime: 3,
    desc: 'A home for your people. Grows while its needs are met and pays taxes.',
  },
  market: {
    name: 'Marketplace', icon: '⚖️', size: 2, tier: 1, cost: { gold: 150, wood: 8 },
    needsRoad: true, service: 'market', radius: 10, zone: 12, buildTime: 8,
    desc: 'Supplies nearby houses with goods and extends the building area.',
  },
  chapel: {
    name: 'Chapel', icon: '⛪', size: 2, tier: 1, cost: { gold: 200, wood: 10, tools: 2 },
    needsRoad: true, service: 'faith', radius: 12, buildTime: 8,
    desc: 'Fulfils the faith need of nearby houses. Settlers will not live without one.',
  },
  woodcutter: {
    name: 'Woodcutter', icon: '🪓', size: 1, tier: 1, cost: { gold: 50, wood: 2 },
    needsRoad: true, buildTime: 5,
    prod: { out: 'wood', n: 1, cycle: 4 },
    req: { trees: { r: 4, n: 3 } },
    desc: 'Fells trees for wood. Needs at least 3 trees nearby.',
  },
  fisher: {
    name: "Fisher's Hut", icon: '🎣', size: 1, tier: 1, cost: { gold: 70, wood: 3 },
    needsRoad: true, buildTime: 5, allowSand: true,
    prod: { out: 'food', n: 2, cycle: 6 },
    req: { coast: true },
    desc: 'Catches fish. Must be built at the waterline.',
  },
  hunter: {
    name: 'Hunting Lodge', icon: '🏹', size: 1, tier: 1, cost: { gold: 60, wood: 2 },
    needsRoad: true, buildTime: 5,
    prod: { out: 'food', n: 1, cycle: 5 },
    req: { trees: { r: 5, n: 5 } },
    desc: 'Hunts game in the woods. Needs at least 5 trees nearby.',
  },
  sheep: {
    name: 'Sheep Farm', icon: '🐑', size: 2, tier: 2, cost: { gold: 120, wood: 6 },
    needsRoad: true, buildTime: 8,
    prod: { out: 'wool', n: 1, cycle: 7 },
    req: { pasture: { r: 3, n: 8 } },
    desc: 'Produces wool. Needs open grassland around it.',
  },
  weaver: {
    name: "Weaver's Hut", icon: '🧵', size: 1, tier: 2, cost: { gold: 140, wood: 5, tools: 2 },
    needsRoad: true, buildTime: 5,
    prod: { out: 'cloth', n: 1, cycle: 7, in: { wool: 1 } },
    desc: 'Weaves wool into cloth — needed for Settlers.',
  },
  mine: {
    name: 'Iron Mine', icon: '⛏️', size: 1, tier: 2, cost: { gold: 200, wood: 8, tools: 2 },
    needsRoad: true, buildTime: 6,
    prod: { out: 'iron', n: 1, cycle: 8 },
    req: { rock: true },
    desc: 'Digs iron ore. Must be built against a mountain.',
  },
  toolmaker: {
    name: 'Toolmaker', icon: '🔨', size: 1, tier: 2, cost: { gold: 180, wood: 6 },
    needsRoad: true, buildTime: 6,
    prod: { out: 'tools', n: 1, cycle: 9, in: { iron: 1 } },
    desc: 'Forges iron into tools so you need not buy them from the trader.',
  },
  grain: {
    name: 'Grain Farm', icon: '🌾', size: 2, tier: 2, cost: { gold: 140, wood: 6 },
    needsRoad: true, buildTime: 8,
    prod: { out: 'grain', n: 1, cycle: 5 },
    req: { pasture: { r: 3, n: 8 } },
    desc: 'Grows golden wheat on open grassland.',
  },
  bakery: {
    name: 'Bakery', icon: '🥖', size: 1, tier: 2, cost: { gold: 200, wood: 8, tools: 2 },
    needsRoad: true, buildTime: 6,
    prod: { out: 'food', n: 3, cycle: 7, in: { grain: 1 } },
    desc: 'Bakes bread from grain — feeds far more mouths than fishing alone.',
  },
  depot: {
    name: 'Depot', icon: '📦', size: 2, tier: 2, cost: { gold: 300, wood: 20, tools: 5 },
    needsRoad: false, buildTime: 8, zone: 12, storage: STORAGE_PER_DEPOT,
    desc: 'Extends the building area, raises storage by 150 and accepts road connections.',
  },
  kontor: {
    name: 'Kontor', icon: '⛵', size: 2, tier: 2, cost: { gold: 1500, wood: 30, tools: 10, food: 20 },
    needsRoad: false, buildTime: 15, zone: 14, storage: 150, ignoreZone: true,
    allowSand: true, coastal: true,
    desc: 'Expedition: found a colony on a new island. Must stand at the waterline. Extends the building area there, adds storage, and your cargo ships keep it supplied.',
  },
  watchtower: {
    name: 'Watchtower', icon: '🗼', size: 1, tier: 2, cost: { gold: 250, wood: 10, tools: 5, iron: 5 },
    needsRoad: false, buildTime: 8, range: 9, allowSand: true,
    desc: 'Cannons fire at pirate ships within range. Place near your coast.',
  },
  firehouse: {
    name: 'Fire Station', icon: '🚒', size: 2, tier: 2, cost: { gold: 200, wood: 10, tools: 3 },
    needsRoad: true, buildTime: 8, radius: 11,
    desc: 'The brigade extinguishes fires in nearby buildings before they burn down.',
  },
  tavern: {
    name: 'Tavern', icon: '🍺', size: 2, tier: 3, cost: { gold: 250, wood: 15, tools: 3 },
    needsRoad: true, service: 'fun', radius: 12, buildTime: 8,
    desc: 'Ale and gossip — Citizens demand entertainment.',
  },
  potato: {
    name: 'Potato Farm', icon: '🥔', size: 2, tier: 3, cost: { gold: 150, wood: 6 },
    needsRoad: true, buildTime: 8,
    prod: { out: 'potato', n: 1, cycle: 6 },
    req: { pasture: { r: 3, n: 8 } },
    desc: 'Grows potatoes on open grassland.',
  },
  distillery: {
    name: 'Distillery', icon: '🥃', size: 1, tier: 3, cost: { gold: 220, wood: 8, tools: 3 },
    needsRoad: true, buildTime: 6,
    prod: { out: 'liquor', n: 1, cycle: 8, in: { potato: 1 } },
    desc: 'Distils potatoes into liquor — needed for Citizens.',
  },
};

// Toolbar layout (null = separator)
const TOOLBAR_ITEMS = [
  'road', 'house', 'market', 'chapel', null,
  'woodcutter', 'fisher', 'hunter', null,
  'sheep', 'weaver', 'grain', 'bakery', 'mine', 'toolmaker', 'depot', null,
  'watchtower', 'firehouse', 'kontor', null,
  'tavern', 'potato', 'distillery',
];

/* Sequential quests shown in the goal bar. check() runs against the game
 * state; reward is granted on completion. */
const QUESTS = [
  { text: 'Build a Marketplace near your Warehouse', reward: { gold: 100 },
    check: () => G.buildings.some(b => b.key === 'market' && b.done) },
  { text: 'Get a Fisher\'s Hut working (waterline + road)', reward: { gold: 100 },
    check: () => G.buildings.some(b => b.key === 'fisher' && b.status === 'ok') },
  { text: 'House 16 Pioneers', reward: { wood: 20 },
    prog: () => [popOf(0), 16],
    check: () => popOf(0) >= 16 },
  { text: 'Get a Woodcutter working', reward: { gold: 150 },
    check: () => G.buildings.some(b => b.key === 'woodcutter' && b.status === 'ok') },
  { text: 'Build a Chapel', reward: { gold: 150 },
    check: () => G.buildings.some(b => b.key === 'chapel' && b.done) },
  { text: 'Reach 24 Pioneers to unlock Settlers', reward: { tools: 5 },
    prog: () => [popOf(0), 24],
    check: () => G.unlocked >= 2 },
  { text: 'Weave 5 cloth (Sheep Farm → Weaver)', reward: { gold: 200 },
    prog: () => [Math.floor(G.stock.cloth), 5],
    check: () => G.stock.cloth >= 5 },
  { text: 'Upgrade a house to Settlers', reward: { gold: 200 },
    check: () => G.buildings.some(b => b.key === 'house' && b.tier >= 1) },
  { text: 'Forge your own tools (Iron Mine + Toolmaker working)', reward: { gold: 300 },
    check: () => G.buildings.some(b => b.key === 'mine' && b.status === 'ok') &&
                 G.buildings.some(b => b.key === 'toolmaker' && b.status === 'ok') },
  { text: 'Bake bread (Grain Farm → Bakery working)', reward: { gold: 250 },
    check: () => G.buildings.some(b => b.key === 'bakery' && b.status === 'ok') },
  { text: 'Reach 30 Settlers to unlock Citizens', reward: { gold: 300 },
    prog: () => [popOf(1), 30],
    check: () => G.unlocked >= 3 },
  { text: 'Found a colony on another island (build a Kontor ⛵)', reward: { gold: 500 },
    check: () => G.buildings.some(b => b.key === 'kontor' && b.done) },
  { text: 'Get a Distillery working (Potato Farm → Distillery)', reward: { gold: 300 },
    check: () => G.buildings.some(b => b.key === 'distillery' && b.status === 'ok') },
  { text: 'Upgrade a house to Citizens', reward: { gold: 500 },
    check: () => G.buildings.some(b => b.key === 'house' && b.tier >= 2) },
  { text: 'Reach 60 Citizens — let your island flourish!', reward: { gold: 1000 },
    prog: () => [popOf(2), 60],
    check: () => popOf(2) >= 60 },
];

// bundle colors for goods carried by walkers
const GOOD_COLORS = {
  wood: '#8a6034', tools: '#5a5a64', iron: '#7a7a82', food: '#9ab8c8',
  grain: '#d8b13c', wool: '#eeeae0', cloth: '#b84a3c', potato: '#c8a060', liquor: '#c88a2a',
};

const SAVE_KEY = 'new-shores-v1';
const SAVE_KEY_LEGACY = 'anno1701-newshores-v1'; // migrate old local saves
