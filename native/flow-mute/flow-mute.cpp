// ---------------------------------------------------------------------------
// flow-mute : coupe le son des AUTRES applications pendant une dictee.
//
// 2026-08-04, demande de Roch : « quand le raccourci est active et que le
// speech-to-text est en fonction, tous les bruits et les sons de toutes les
// applications de l'ordinateur sont muets jusqu'a ce que le raccourci soit
// lache. »
//
// ---------------------------------------------------------------------------
// POURQUOI UN PROCESSUS A PART, ET NON UN MODULE DANS FLOW
// ---------------------------------------------------------------------------
//
// Le processus principal de Flow porte le CROCHET CLAVIER. Windows revoque un
// crochet de bas niveau qui met trop de temps a repondre, et une violation
// d'acces dans du code natif charge dans ce processus ne ralentit pas la dictee :
// elle la tue, au milieu d'une phrase. Aucune fonctionnalite de confort ne merite
// ce risque-la.
//
// Ce programme peut donc mourir sans consequence. Et son isolement achete la
// garantie qui compte le plus ici :
//
//   IL REMET LE SON EN QUITTANT, QUOI QU'IL ARRIVE.
//
// Quand Flow disparait - fermeture propre, plantage, arret force - le tuyau
// d'entree se ferme, ce programme lit une fin de fichier, retablit ce qu'il avait
// coupe, et sort. Aucun filet cote Flow ne pourrait etre aussi solide : un
// processus qui meurt n'execute plus rien, mais celui-ci n'est pas celui qui
// meurt.
//
// ---------------------------------------------------------------------------
// CE QU'IL NE COUPE PAS, ET POURQUOI
// ---------------------------------------------------------------------------
//
//  - FLOW LUI-MEME. Reconnu par le CHEMIN de son executable, pas par son
//    identifiant de processus : Chromium joue le son de depart/arret depuis un
//    processus separe (son service audio), lance depuis le MEME executable. Un
//    filtre par identifiant aurait coupe le son de Flow tout en croyant
//    l'epargner.
//  - CE QUI ETAIT DEJA MUET. Si quelqu'un a coupe son navigateur lui-meme, le
//    retablissement ne doit pas le rallumer. Seules les sessions que ce programme
//    a reellement coupees sont retablies.
//  - LES SESSIONS INACTIVES. Une application qui ne joue rien n'a pas besoin
//    d'etre coupee. C'est le plus petit rayon d'action possible, et c'est le bon
//    instinct pour une fonctionnalite qui touche l'etat d'autres programmes.
//
// LIMITE CONNUE, ECRITE PLUTOT QUE DECOUVERTE : une application qui COMMENCE a
// jouer pendant la dictee n'est pas coupee. Suivre les nouvelles sessions
// demanderait de s'abonner aux notifications de session ; pour une dictee de
// quelques secondes, le gain ne vaut pas la machinerie.
//
// ---------------------------------------------------------------------------
// LE PROTOCOLE : une ligne par commande, sur l'entree standard
// ---------------------------------------------------------------------------
//
//   mute\n    -> coupe, repond "muted <n>"
//   unmute\n  -> retablit, repond "unmuted <n>"
//   (fin de fichier) -> retablit et sort
//
// Une ligne par commande plutot qu'un processus par pression : lancer un
// programme coute des dizaines de millisecondes et attire l'antivirus a chaque
// dictee. Celui-ci vit aussi longtemps que Flow.
// ---------------------------------------------------------------------------

#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <endpointvolume.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

/** Le chemin de l'executable a EPARGNER, en minuscules. */
std::wstring g_selfExe;

/** Les sessions que NOUS avons coupees, et qu'il faut retablir. Gardees comme
 * interfaces vivantes : retrouver la meme session par identifiant apres coup
 * n'est pas fiable (un processus peut ouvrir plusieurs sessions). */
std::vector<ISimpleAudioVolume *> g_muted;

std::wstring lower(std::wstring s) {
  for (auto &c : s) c = (wchar_t)towlower(c);
  return s;
}

/** Le chemin complet de l'executable d'un processus, ou vide. */
std::wstring exePathOf(DWORD pid) {
  if (pid == 0) return L"";
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return L"";
  wchar_t buf[MAX_PATH * 2];
  DWORD n = (DWORD)(sizeof(buf) / sizeof(buf[0]));
  std::wstring out;
  if (QueryFullProcessImageNameW(h, 0, buf, &n)) out.assign(buf, n);
  CloseHandle(h);
  return out;
}

void releaseRemembered() {
  for (auto *v : g_muted) if (v) v->Release();
  g_muted.clear();
}

/** Retablit exactement ce que nous avions coupe. Rend combien. */
int restore() {
  int n = 0;
  for (auto *v : g_muted) {
    if (!v) continue;
    if (SUCCEEDED(v->SetMute(FALSE, nullptr))) n++;
    v->Release();
  }
  g_muted.clear();
  return n;
}

/** Coupe toutes les sessions actives sauf les notres. Rend combien. */
int muteOthers() {
  restore(); // une commande `mute` deux fois de suite ne doit pas empiler

  IMMDeviceEnumerator *enumr = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator), (void **)&enumr)))
    return 0;

  int muted = 0;
  IMMDevice *device = nullptr;
  if (SUCCEEDED(enumr->GetDefaultAudioEndpoint(eRender, eMultimedia, &device)) && device) {
    IAudioSessionManager2 *mgr = nullptr;
    if (SUCCEEDED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void **)&mgr)) && mgr) {
      IAudioSessionEnumerator *sessions = nullptr;
      if (SUCCEEDED(mgr->GetSessionEnumerator(&sessions)) && sessions) {
        int count = 0;
        sessions->GetCount(&count);
        for (int i = 0; i < count; i++) {
          IAudioSessionControl *ctl = nullptr;
          if (FAILED(sessions->GetSession(i, &ctl)) || !ctl) continue;

          AudioSessionState state = AudioSessionStateExpired;
          bool skip = FAILED(ctl->GetState(&state)) || state != AudioSessionStateActive;

          if (!skip) {
            IAudioSessionControl2 *ctl2 = nullptr;
            if (SUCCEEDED(ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void **)&ctl2)) && ctl2) {
              DWORD pid = 0;
              if (SUCCEEDED(ctl2->GetProcessId(&pid))) {
                // Flow, reconnu par son CHEMIN : son service audio est un autre
                // processus lance depuis le meme executable.
                if (!g_selfExe.empty() && lower(exePathOf(pid)) == g_selfExe) skip = true;
              }
              ctl2->Release();
            }
          }

          if (!skip) {
            ISimpleAudioVolume *vol = nullptr;
            if (SUCCEEDED(ctl->QueryInterface(__uuidof(ISimpleAudioVolume), (void **)&vol)) && vol) {
              BOOL already = FALSE;
              // Deja muet par la main de quelqu'un : on n'y touche pas, sinon le
              // retablissement le rallumerait.
              if (SUCCEEDED(vol->GetMute(&already)) && !already && SUCCEEDED(vol->SetMute(TRUE, nullptr))) {
                g_muted.push_back(vol); // garde la reference pour le retablir
                muted++;
              } else {
                vol->Release();
              }
            }
          }
          ctl->Release();
        }
        sessions->Release();
      }
      mgr->Release();
    }
    device->Release();
  }
  enumr->Release();
  return muted;
}

} // namespace

int wmain(int argc, wchar_t **argv) {
  // argv[1] = le chemin de l'executable a epargner. Passe par Flow plutot que
  // devine ici : le parent de ce processus n'est pas forcement celui qui joue le
  // son, et un helper qui devine se trompe en silence.
  if (argc > 1) g_selfExe = lower(argv[1]);

  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) {
    fprintf(stderr, "com-init-failed\n");
    return 2;
  }

  char line[512];
  // `fgets` rend NULL sur une fin de fichier : c'est le signal « Flow n'est plus
  // la ». Le retablissement se fait alors avant de sortir, et c'est toute la
  // raison d'etre de ce processus separe.
  while (fgets(line, sizeof(line), stdin)) {
    char *nl = strpbrk(line, "\r\n");
    if (nl) *nl = 0;
    if (strcmp(line, "mute") == 0) {
      printf("muted %d\n", muteOthers());
      fflush(stdout);
    } else if (strcmp(line, "unmute") == 0) {
      printf("unmuted %d\n", restore());
      fflush(stdout);
    } else if (strcmp(line, "quit") == 0) {
      break;
    }
  }

  restore();
  releaseRemembered();
  CoUninitialize();
  return 0;
}
