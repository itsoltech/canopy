# Profile Sandbox

Status (2026-11-22): katalog właściciela i wybór profilu w wątku działają
w web/desktop. Harmonogramy nowych wątków obsługują wybór także na mobile.
Dostępność wydań wynika z [promocji](release.md). Obsługa zależy od raportu
wybranej instancji dostawcy na workerze.

## Wybór profilu w wątku

Settings → Threads → Sandbox profiles zapisuje nazwy i listy dokładnych domen.
W wątku właściciel wybiera **Sandbox** i **Harness default** lub zapisany
profil. **Harness default** zachowuje dotychczasowe zachowanie harnessu.
Pusta lista w nazwanym profilu wyłącza ruch wychodzący poleceń. Lista domen
dopuszcza tylko podane hosty. Zakres dotyczy poleceń uruchamianych przez
sandbox harnessu. Ruch inferencji, konektory i narzędzia gatewaya mają własne
ustawienia i granty. Reguły zapisu plików w workspace wynikają z sandboxa
danego harnessu.

Gateway zachowuje snapshot wybranego profilu w wątku. Edycja lub usunięcie
w katalogu wpływa na dalsze wybory. Zmiana przypisania wątku wymaga
zakończenia tur i zadań oraz potwierdzenia zamknięcia załadowanej sesji
przez workera. Kolejne tury biegną z nowym przypisaniem. Wątki z nazwanym
profilem kolejkują wiadomości. Bezpośredni shell kompozytora, zmiany
uprawnień aktywnej tury i operacje, które nie zachowują profilu, zwracają
powód odmowy.

Szkic nowego wątku zapisuje wybraną wersję profilu lokalnie i przy
synchronizacji. Gdy wybrany profil zmieni się w katalogu lub z niego
zniknie, szkic zachowuje wybór i prosi o wybranie dostępnego profilu albo
przejście na **Harness default** przed wysłaniem.

## Harmonogramy

Harmonogram tworzący nowy wątek zapisuje własny snapshot profilu. Zmiana lub
usunięcie wpisu katalogu zachowuje ustalony profil harmonogramu. Właściciel
zmienia go jawnie w edytorze. Gateway wybiera workera, który zgłosił obsługę
dla wymaganej instancji. Gdy żaden worker nie spełnia warunków, działa
ustawiona reguła wznowienia po pominiętym uruchomieniu. Harmonogram istniejącego
wątku stosuje aktualny profil tego wątku i kolejkuje wiadomość.

## Zgodność

- **Codex:** nazwany profil offline działa na workerze Linux z działającym
  Bubblewrap, CLI 0.171.0 i instancją z własnym endpointem API bez połączonego
  logowania Codexa.
  Adapter potwierdza wybraną politykę i odmawia przy niezgodnych
  wymaganiach administratora. Dokładna lista domen wymaga również
  ograniczenia zapisanych reguł sieci Codexa. Canopy pokazuje tę opcję jako
  niedostępną na instancjach, dla których nie może tego potwierdzić.
- **Claude:** profil offline i lista dokładnych domen korzystają ze
  ścisłej listy SDK. Worker potrzebuje działającego Bubblewrap i socat,
  Claude Code 2.1.316 albo 2.1.330 oraz instancji z własnym endpointem API. Adapter
  odmawia uruchomienia, gdy nie może zachować obowiązujących ograniczeń.
- **Windows:** domyślny natywny backend Codexa nie potwierdza izolacji
  wymaganej przez nazwany profil. Claude wymaga workera i CLI uruchomionych
  wewnątrz Linuxa, np. w WSL2. WSL2 podlega tym samym kontrolom workera.
  macOS i Grok nie zgłaszają obsługi nazwanych profili w tej wersji.

## Transport i ponowienia

Wiązanie zawiera identyfikator, nazwę, znormalizowaną listę domen i skrót.
Gateway sprawdza aktualny raport workera przy przyjęciu wyboru, starcie tury
i ponownym wysłaniu komendy. Komendy profilu niosą osobną kopertę
`profiled_thread`. Starszy worker odmawia z powodu brakującego zwykłego
opisu wątku. Nowszy worker sprawdza skrót i obsługę profilu przed
uruchomieniem harnessu. Baza odrzuca wykonawcze wpisy w outboxie, które
nie przenoszą przypisanego skrótu. Wycofanie binarki gatewaya nie może
przełączyć takich tur na zwykły sandbox.
Baza chroni również przypisania w harmonogramach i zapisanych szkicach przed
nadpisaniem przez starszy gateway.
