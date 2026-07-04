"""Asset manifest: every sprite the game needs, with its prompt and layout.

w      = target logical width in game pixels (PNG is stored at 2x for crispness)
oyk    = baseline anchor as a fraction of the image height (bottom inset);
         the renderer places `oy` at the bottom vertex of the footprint diamond
kind   = 'object' (white-bg sprite, background removed) or 'texture' (seamless tile)
"""

STYLE = (
    "isometric video game sprite of {desc}, 3/4 top-down isometric view, "
    "single subject centered on a plain solid white background, "
    "18th century caribbean colonial trading town style, warm sunlight from the upper left, "
    "softly painted, clean crisp silhouette, vibrant colors, no text, no watermark"
)

TEXTURE_STYLE = (
    "seamless repeating texture of {desc}, flat top-down view, even lighting, "
    "subtle natural variation, video game terrain texture, no text, no watermark"
)

ASSETS = [
    # ---- houses: 2 variants per tier ----
    dict(key="house0_0", w=72, seed=101, desc="a small pioneer log cabin with rough timber walls and a thatched straw roof, tiny window, wooden door"),
    dict(key="house0_1", w=72, seed=102, desc="a small pioneer settler hut with timber walls and a thatched straw roof, little garden patch"),
    dict(key="house1_0", w=74, seed=111, desc="a modest settler townhouse with timber-framed white walls and a red tiled gable roof, brick chimney"),
    dict(key="house1_1", w=74, seed=112, desc="a settler family house, half-timbered walls, steep red shingle roof, flower box windows"),
    dict(key="house2_0", w=76, seed=121, desc="a stately two-storey citizen stone townhouse with a blue slate roof, dormer window, stone steps"),
    dict(key="house2_1", w=76, seed=122, desc="a two-storey citizen town home, pale stone walls, dark blue slate roof, arched doorway, chimney"),
    dict(key="house3_0", w=78, seed=131, desc="a grand merchant mansion, cream stucco facade, ornate wooden balcony, dark slate roof, gilded finial"),
    dict(key="house3_1", w=78, seed=142, desc="a rich merchant townhouse seen from a three-quarter angle, elegant white facade, wrought-iron balcony, purple slate mansard roof, golden trim"),
    # ---- production & civic buildings ----
    dict(key="warehouse", w=140, seed=42, desc="a large colonial warehouse with a stone ground floor and timber-framed upper floor, orange gabled roof, small flag on the ridge, crates and barrels in the yard"),
    dict(key="market", w=138, seed=201, desc="an open marketplace square with colorful cloth market stalls and striped awnings, crates of fruit and goods"),
    dict(key="chapel", w=132, seed=202, desc="a small stone chapel with a bell tower, arched windows and a modest cross on the spire"),
    dict(key="woodcutter", w=76, seed=203, desc="a woodcutter's lodge with stacked firewood logs, a chopping block with an axe, sawdust"),
    dict(key="fisher", w=76, seed=204, desc="a small fisherman's hut with a blue roof, wooden jetty, hanging fishing nets and a barrel of fish"),
    dict(key="hunter", w=76, seed=205, desc="a hunting lodge log cabin with antlers above the door and fur pelts drying on a rack"),
    dict(key="sheep", w=138, seed=206, desc="a sheep farm with a wooden barn and a fenced green pasture with two white sheep grazing"),
    dict(key="weaver", w=76, seed=227, desc="a weaver's cottage workshop with bales of white wool stacked outside and a loom visible through the open door"),
    dict(key="mine", w=78, seed=208, desc="an iron mine entrance timbered into a rocky hillside, wooden support beams, a mine cart full of ore"),
    dict(key="toolmaker", w=76, seed=229, desc="a blacksmith's forge workshop building, exterior view, stone walls, glowing furnace mouth, anvil outside, smoking chimney"),
    dict(key="grain", w=138, seed=210, desc="a grain farm with rows of golden wheat, a small thatched barn and a haystack"),
    dict(key="bakery", w=76, seed=211, desc="a bakery with a domed stone bread oven, warm glowing oven mouth, hanging bread sign"),
    dict(key="depot", w=136, seed=212, desc="a storage depot: a sturdy wooden warehouse with stacked crates and barrels under a lean-to roof"),
    dict(key="kontor", w=138, seed=213, desc="a harbour trading post with a wooden pier, stacked cargo crates, a hoist crane and a blue-and-white pennant"),
    dict(key="watchtower", w=70, seed=214, desc="a round stone watchtower with battlements and a small bronze cannon on top"),
    dict(key="firehouse", w=136, seed=215, desc="a fire brigade station with red double doors, water barrels, a bronze alarm bell and a ladder on the wall"),
    dict(key="tavern", w=138, seed=216, desc="a lively tavern with a hanging beer-mug sign, ale barrels and wooden benches outside"),
    dict(key="potato", w=138, seed=217, desc="a potato farm with leafy green furrow rows, a small farmhouse and sacks of potatoes"),
    dict(key="distillery", w=76, seed=218, desc="a rum distillery with a shiny copper still, wooden barrels and a small chimney"),
    dict(key="spice", w=138, seed=219, desc="a spice garden farm with rows of red chili pepper plants and wooden drying racks hung with strings of red peppers"),
    # ---- construction sites ----
    dict(key="scaffold1", w=72, seed=301, desc="a small construction site: half-built stone walls surrounded by wooden scaffolding, planks and a mortar bucket"),
    dict(key="scaffold2", w=132, seed=302, desc="a large construction site: half-built building surrounded by wooden scaffolding, beams, planks and stacked bricks"),
    # ---- nature ----
    dict(key="tree0", w=34, seed=401, desc="a single tall pine tree with layered dark green branches", oyk=0.97, strip=True),
    dict(key="tree1", w=34, seed=412, desc="a single slender fir tree with deep dark green needles", oyk=0.97, strip=True),
    dict(key="tree2", w=40, seed=403, desc="a single leafy round oak tree with a thick trunk", oyk=0.97, strip=True),
    dict(key="tree3", w=40, seed=404, desc="a single broad deciduous tree with lush green foliage", oyk=0.97, strip=True),
    dict(key="rock0", w=54, seed=405, desc="a large grey rocky boulder outcrop with mossy patches"),
    dict(key="rock1", w=54, seed=406, desc="a cluster of jagged grey mountain rocks with lichen"),
    # ---- ships ----
    dict(key="ship", w=68, seed=501, oyk=0.80, desc="a small square-rigged colonial trading ship with white sails and a wooden hull, side view, hull fully visible, no water"),
    dict(key="pirateship", w=68, seed=502, oyk=0.80, desc="a pirate ship with dark tattered sails, a black jolly roger flag and a dark weathered hull, side view, hull fully visible, no water"),
    dict(key="boat", w=30, seed=507, oyk=0.78, desc="a tiny simple wooden rowboat with a lone fisherman holding a fishing rod, side view, hull fully visible, no water"),
    # ---- people (animated in-engine via bob/lean/swing transforms) ----
    dict(key="peep_v0", fith=15, seed=701, strip=True, oyk=1.0, desc="a peasant villager man in simple 18th century clothes and a straw hat, walking, full body"),
    dict(key="peep_v1", fith=15, seed=702, strip=True, oyk=1.0, desc="a peasant woman in a simple 18th century dress, apron and bonnet, walking, full body"),
    dict(key="peep_v2", fith=12, seed=703, strip=True, oyk=1.0, desc="a young villager boy in simple colonial clothes, walking, full body"),
    dict(key="peep_v3", fith=15, seed=704, strip=True, oyk=1.0, desc="a villager woman in a colonial skirt carrying a wicker basket, walking, full body"),
    dict(key="peep_carrier", fith=15, seed=705, strip=True, oyk=1.0, desc="a dock worker man carrying a wooden crate on his shoulder, simple 18th century clothes, walking, full body"),
    dict(key="peep_chop", fith=15, seed=706, strip=True, oyk=1.0, desc="a lumberjack swinging a woodcutting axe, simple 18th century clothes, full body, side view"),
    dict(key="peep_hammer", fith=15, seed=707, strip=True, oyk=1.0, desc="a blacksmith holding a raised hammer, leather apron, 18th century clothes, full body, side view"),
    dict(key="peep_bend", fith=14, seed=708, strip=True, oyk=1.0, desc="a farmer bending forward harvesting crops with both hands, straw hat, 18th century clothes, full body, side view"),
    dict(key="peep_idle", fith=15, seed=709, strip=True, oyk=1.0, desc="a workman standing relaxed with a tool belt, simple 18th century clothes, full body"),
]

ICON_STYLE = (
    "game inventory icon of {desc}, single object centered, "
    "plain solid white background, 18th century colonial style, softly painted, "
    "vibrant colors, subtle shading, no text, no letters, no watermark"
)

# UI icons (resources, population tiers, toolbar utilities) — 64x64 with alpha
ICONS = [
    dict(key="ico_gold", seed=801, desc="a small stack of shiny gold coins"),
    dict(key="ico_wood", seed=802, desc="three stacked wooden logs"),
    dict(key="ico_tools", seed=803, desc="a crossed hammer and wrought-iron pliers"),
    dict(key="ico_iron", seed=804, desc="two grey iron ingots"),
    dict(key="ico_food", seed=805, desc="a fresh fish and a loaf of bread"),
    dict(key="ico_grain", seed=806, desc="a golden sheaf of wheat tied with string"),
    dict(key="ico_wool", seed=807, desc="a fluffy ball of white wool with a strand"),
    dict(key="ico_cloth", seed=808, desc="a folded bolt of red cloth fabric"),
    dict(key="ico_potato", seed=809, desc="three brown potatoes"),
    dict(key="ico_liquor", seed=810, desc="a rum bottle with a small full glass"),
    dict(key="ico_spice", seed=811, desc="a pile of red chili peppers"),
    dict(key="ico_pop0", seed=821, desc="portrait bust of a pioneer farmer man with a straw hat"),
    dict(key="ico_pop1", seed=822, desc="portrait bust of a settler woman with a bonnet"),
    dict(key="ico_pop2", seed=823, desc="portrait bust of a citizen gentleman with a tricorn hat"),
    dict(key="ico_pop3", seed=824, desc="portrait bust of a wealthy merchant with a gold chain and fine hat"),
    dict(key="ico_road", seed=831, desc="a short curved cobblestone road segment"),
    dict(key="ico_demolish", seed=832, desc="a heavy wooden mallet"),
    dict(key="ico_trade", seed=833, desc="a balance scale with gold coins"),
    dict(key="ico_exped", seed=834, desc="an antique brass compass rose"),
    dict(key="ico_achieve", seed=835, desc="a golden trophy cup with a laurel wreath"),
    dict(key="ico_stats", seed=836, desc="a parchment scroll with a rising chart line drawn on it"),
    dict(key="ico_help", seed=837, desc="an open leather-bound book"),
    dict(key="ico_save", seed=838, desc="a letter sealed with red wax"),
    dict(key="ico_new", seed=839, desc="a rolled-up treasure map with a red ribbon"),
]

TEXTURES = [
    dict(key="tex_grass", seed=601, desc="lush green meadow grass"),
    dict(key="tex_sand", seed=602, desc="warm light beach sand with faint ripples"),
    dict(key="tex_water", seed=603, desc="calm tropical sea water, mid blue with gentle small waves"),
    dict(key="tex_deep", seed=604, desc="deep dark ocean water, dark navy blue with gentle small waves"),
    dict(key="tex_rock", seed=605, desc="grey rocky stone ground with cracks"),
]
