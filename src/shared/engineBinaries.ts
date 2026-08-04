// ---------------------------------------------------------------------------
// 2026-08-04, PORTAGE macOS : LE NOM DES BINAIRES DE MOTEUR, PAR PLATEFORME.
//
// Un seul endroit, et c'est le point : ces noms apparaissaient dans QUATRE
// fichiers qui ne se parlent pas - le script qui les telecharge, le manifeste qui
// epingle leurs empreintes, la resolution du chemin au demarrage, et le garde-fou
// du workflow de release qui verifie leur presence dans le zip. Ajouter une
// plateforme en modifiant trois des quatre produit exactement la panne de la
// 1.22.0 : un installeur qui se construit, se signe, s'installe, et dans lequel la
// fonctionnalite n'existe pas.
//
// ---------------------------------------------------------------------------
// CE QUI EXISTE VRAIMENT EN AMONT, VERIFIE PLUTOT QUE SUPPOSE (2026-08-04)
// ---------------------------------------------------------------------------
//
// Les deux moteurs ont des versions macOS officielles, AUX MEMES TAGS que ceux
// que Flow epingle deja pour Windows :
//
//   OpenWhispr/whisper.cpp 0.0.8  -> whisper-server-darwin-arm64.zip (1,3 Mo)
//   ggml-org/llama.cpp     b10234 -> llama-b10234-bin-macos-arm64.tar.gz (11 Mo)
//
// Leurs empreintes SHA-256 ont ete calculees en les telechargeant depuis ces
// tags-la et vivent dans scripts/native-deps.json, comme les autres. C'etait la
// plus grosse inconnue du portage, et elle tombe du bon cote : rien a compiler.
//
// ARM64 SEULEMENT. Un Mac Intel n'est pas couvert, et c'est un choix : le second
// ordinateur de Roch est un MacBook recent, l'asset x64 existe si le besoin
// apparait, et pretendre couvrir un materiel qu'on ne peut pas essayer serait la
// meme promesse creuse que ce depot retire ailleurs.
//
// PAS DE VARIANTE DE BACKEND SUR MAC, et ce n'est pas un oubli : sur Windows Flow
// embarque deux constructions (Vulkan puis CPU) et choisit a l'execution, parce
// qu'un pilote GPU peut charger puis rendre du texte vide. Sur macOS, Metal fait
// partie du systeme : il n'y a qu'une construction, donc rien a choisir.
// ---------------------------------------------------------------------------

/** Le moteur de parole : les binaires a essayer, dans l'ORDRE de preference.
 *
 * `forceCpu` n'a de sens que la ou il y a deux constructions ; sur macOS il est
 * ignore, et le dire ici evite qu'un appelant croie l'avoir applique. */
export function whisperServerNames(platform: string, forceCpu = false): string[] {
  if (platform === "darwin") return ["whisper-server-darwin-arm64"];
  const vulkan = "whisper-server-win32-x64-vulkan.exe";
  const cpu = "whisper-server-win32-x64-cpu.exe";
  return forceCpu ? [cpu] : [vulkan, cpu];
}

/** Le moteur qui redige les notes. Un seul nom par plateforme. */
export function llamaServerName(platform: string): string {
  return platform === "darwin" ? "llama-server" : "llama-server.exe";
}

/** L'asset a telecharger pour cette plateforme, et le nom du fichier attendu
 * apres extraction. Ce que le script de recuperation et le manifeste d'empreintes
 * doivent voir de la meme facon. */
export interface EngineAsset {
  asset: string;
  /** Le fichier attendu dans resources/bin apres extraction. */
  binary: string;
}

export function whisperAssets(platform: string): EngineAsset[] {
  if (platform === "darwin") {
    return [{ asset: "whisper-server-darwin-arm64.zip", binary: "whisper-server-darwin-arm64" }];
  }
  return [
    { asset: "whisper-server-win32-x64-vulkan.zip", binary: "whisper-server-win32-x64-vulkan.exe" },
    { asset: "whisper-server-win32-x64-cpu.zip", binary: "whisper-server-win32-x64-cpu.exe" },
  ];
}

/** L'asset de llama.cpp, dont le nom porte la version. */
export function llamaAsset(platform: string, version: string): EngineAsset {
  return platform === "darwin"
    ? { asset: `llama-${version}-bin-macos-arm64.tar.gz`, binary: "llama-server" }
    : { asset: `llama-${version}-bin-win-vulkan-x64.zip`, binary: "llama-server.exe" };
}
