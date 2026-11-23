# Logo Canopy

Korona i konary tworzą wspólny obrys drzewa. Logotyp łączy drzewo z literą „a”.
[Znak](canopy-mark.svg) · [Logotyp na jasne tło](canopy-wordmark.svg) · [Logotyp na ciemne tło](canopy-wordmark-inverse.svg)

## Ikony aplikacji

| Stable | Beta | Nightly | Dev |
| --- | --- | --- | --- |
| [<img src="app-icons/canopy-stable.svg" width="64" height="64" alt="Zielone drzewo na szałwiowym tle">](app-icons/canopy-stable.svg) | [<img src="app-icons/canopy-beta.svg" width="64" height="64" alt="Drzewo i dwa opadające liście na bursztynowym tle">](app-icons/canopy-beta.svg) | [<img src="app-icons/canopy-nightly.svg" width="64" height="64" alt="Lawendowe drzewo z półksiężycem i gwiazdami na fioletowym tle">](app-icons/canopy-nightly.svg) | [<img src="app-icons/canopy-dev.svg" width="64" height="64" alt="Rysunek techniczny drzewa na niebieskiej siatce">](app-icons/canopy-dev.svg) |

Po zmianie tych SVG uruchom `bun scripts/icons/channel-icons.ts` w katalogu głównym repozytorium.
Generator odtwarza ikony webowe, PNG i ICO dla desktopu, ICNS dla Dev oraz zasoby mobilne.

### macOS i iOS

Projekty Icon Composer dla [Stable](apple/canopy-stable.icon), [Beta](apple/canopy-beta.icon)
i [Nightly](apple/canopy-nightly.icon) zawierają całą grafikę kanału jako pojedynczą warstwę SVG.
Po zmianie grafiki podmień warstwę w odpowiednim projekcie. Przy imporcie ustaw w SVG rozmiar
1024 × 1024 i zachowaj oryginalny `viewBox`. Przy zmianie koloru tła zaktualizuj też wypełnienie
projektu. Obie platformy kompilują te projekty za pomocą Xcode 26 lub nowszego.

## Tło sidebara

Drzewo jest widoczne za nawigacją i zanika przy wyszukiwarce, przed pierwszym wątkiem lub botem. Aplikacje webowa, desktopowa i mobilna korzystają ze [wspólnych grafik tła](../../packages/ui/src/sidebar-art.ts).
