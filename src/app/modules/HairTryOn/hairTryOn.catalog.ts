export type StyleGroup = "short" | "medium" | "long" | "curly" | "fade";

export type HairStyle = {
  id: string;
  name: string;
  nameBn: string;
  group: StyleGroup;
  thumbnail: string;
  prompt: string;
};

export type HairColor = {
  id: string;
  name: string;
  nameBn: string;
  swatch: string;
  prompt: string | null;
};

const style = (
  id: string,
  name: string,
  nameBn: string,
  group: StyleGroup,
  prompt: string,
): HairStyle => ({
  id,
  name,
  nameBn,
  group,
  thumbnail: `/hairstyles/${id}.webp`,
  prompt,
});

export const HAIR_STYLES: HairStyle[] = [
  // short
  style("buzz-cut", "Buzz cut", "বাজ কাট", "short", "a very short buzz cut clipped evenly to about 3 mm all over the head, with no parting and a clean natural hairline"),
  style("crew-cut", "Crew cut", "ক্রু কাট", "short", "a classic crew cut, about 1 cm on the sides and back, slightly longer (about 3 cm) on top, brushed up and forward with no parting"),
  style("textured-crop", "Textured crop", "টেক্সচার্ড ক্রপ", "short", "a textured crop with short tapered sides and about 4 cm of choppy, messy texture on top pushed forward into a short blunt fringe"),
  style("pixie-cut", "Pixie cut", "পিক্সি কাট", "short", "a soft pixie cut, short around the ears and nape with slightly longer wispy layers on top swept to one side over the forehead"),
  style("side-part", "Side part", "সাইড পার্ট", "short", "a neat short side-part haircut with a clean parting on the left, the top combed smoothly to the right and short tidy sides"),
  // medium
  style("bob", "Bob", "বব", "medium", "a chin-length straight bob with blunt ends, a soft middle parting and no fringe"),
  style("lob", "Lob", "লব", "medium", "a shoulder-length long bob (lob) with gently textured straight ends and a slightly off-centre parting"),
  style("shag", "Shag", "শ্যাগ", "medium", "a medium-length shag with choppy layers around the face and crown, light natural waves and a wispy fringe"),
  style("curtain-bangs", "Curtain bangs", "কার্টেন ব্যাংস", "medium", "medium-length hair just past the jaw with curtain bangs parted in the middle and swept to both sides, framing the cheekbones"),
  // long
  style("long-layers", "Long layers", "লং লেয়ার্স", "long", "long hair past the shoulders with soft face-framing layers, mostly straight with a slight bend at the ends and a middle parting"),
  style("sleek-straight", "Sleek straight", "স্লিক স্ট্রেইট", "long", "long sleek, glossy, poker-straight hair reaching below the shoulders with a sharp centre parting"),
  style("long-waves", "Long waves", "লং ওয়েভস", "long", "long hair below the shoulders in loose, soft beach waves with a natural side parting"),
  // curly
  style("natural-curls", "Natural curls", "ন্যাচারাল কার্লস", "curly", "medium-length defined natural ringlet curls with volume at the crown and no parting"),
  style("afro", "Afro", "আফ্রো", "curly", "a rounded, full afro of tightly coiled natural hair, evenly shaped about 6 cm out from the scalp"),
  // fade
  style("low-fade", "Low fade", "লো ফেড", "fade", "a low skin fade starting just above the ears, blending into about 4 cm of neatly combed hair on top with a natural side parting"),
  style("high-fade-quiff", "High fade quiff", "হাই ফেড কুইফ", "fade", "a high fade on the sides and back blending into a voluminous quiff on top, about 6 cm long and swept up and back from the forehead"),
];

export const HAIR_COLORS: HairColor[] = [
  { id: "natural", name: "Natural", nameBn: "প্রাকৃতিক", swatch: "transparent", prompt: null },
  { id: "black", name: "Black", nameBn: "কালো", swatch: "#1c1a19", prompt: "deep natural black" },
  { id: "dark-brown", name: "Dark brown", nameBn: "গাঢ় বাদামি", swatch: "#3b2a20", prompt: "rich dark brown" },
  { id: "chestnut", name: "Chestnut", nameBn: "চেস্টনাট", swatch: "#7a4a2a", prompt: "warm chestnut brown" },
  { id: "burgundy", name: "Burgundy", nameBn: "বারগান্ডি", swatch: "#6b1f2e", prompt: "deep burgundy red" },
  { id: "ash-blonde", name: "Ash blonde", nameBn: "অ্যাশ ব্লন্ড", swatch: "#b8ad98", prompt: "cool ash blonde" },
];

export const findStyle = (id: string) => HAIR_STYLES.find((s) => s.id === id);
export const findColor = (id: string) => HAIR_COLORS.find((c) => c.id === id);

/** Same template as the Phase 0 spike, so spike results carry over. */
export const buildPrompt = (
  style: HairStyle,
  color: HairColor,
) => `Edit this photo. Change ONLY the person's hair to: ${style.prompt}.
Hair color: ${color.prompt ? `${color.prompt}.` : "keep the person's natural hair color."}
Keep everything else exactly the same: face shape, facial features, expression,
eyes, eyebrows, skin tone and texture, facial hair, makeup, glasses, clothing,
background, lighting, camera angle and framing.
The hairline must look natural and the hair must have realistic texture and
shadows, like an unretouched photograph. Do not beautify, slim, smooth or
lighten the skin. Do not add accessories or text.`;

/** The catalog as the frontend sees it: no prompts. */
export const publicCatalog = () => ({
  styles: HAIR_STYLES.map(({ prompt: _prompt, ...rest }) => rest),
  colors: HAIR_COLORS.map(({ prompt: _prompt, ...rest }) => rest),
});
