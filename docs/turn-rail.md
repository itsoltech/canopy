# Nawigacja między turami rozmowy

Przy co najmniej trzech widocznych turach oś wątku ma pasek nawigacji w lewym
marginesie. Rezerwuje 36 px obok feedu i nie zasłania wiadomości. Poniżej 768 px
jest ukryty, aby rozmowa zachowała pełną szerokość i gesty przewijania.
Rozwinięta odziedziczona historia uczestniczy w nawigacji; zwinięta historia,
tury w kolejce i wycofane nie uczestniczą.

Każda tura ma kreskę. Widoczne tury mają dłuższe, ciemniejsze kreski, a bieżąca
delikatnie pulsuje. Odstępy są równe, najwyżej 10 px; przy mniej niż 4 px na turę
kreski wizualnie się łączą, zachowując przyciski i dostęp z klawiatury.
Pasek sam się nie przewija.

Hover lub fokus pokazuje wiadomość użytkownika, początek odpowiedzi końcowej
albo bieżącego komentarza i czas tury. Oba teksty używają `MarkdownSnippet`.
Jeden `Popover` przesuwa się między turami bez ponownego otwierania. Pierwszy
hover czeka 500 ms, zamknięcie 200 ms, a ponowne wejście w ciągu 400 ms jest
natychmiastowe. Kit kontroluje pozycjonowanie; padding należy do wrappera treści.

Strzałki przechodzą między turami, Home/End do pierwszej/ostatniej, Enter/Space
przewijają do wybranej, Escape zamyka podgląd. Jest jeden przystanek Tab;
przyciski opisują numer tury, wiadomość, bieżące położenie i otwarty podgląd.

## Integracja z feedem

`rail/turn-rail.ts` wylicza nagłówki tur, indeksy wejść i podglądy z `FeedRow[]`.
Otwarcie historii lub grup pracy przebudowuje indeksy. Wyszukiwanie bieżącej tury
jest binarne i korzysta z rzeczywiście widocznego zakresu, bez overscan oraz
obszaru kompozytora. Nie odczytuje prostokątów DOM wiadomości przy scrollu.
`VirtualFeed` publikuje `onviewport(FeedViewport)` najwyżej raz na klatkę;
`rowOffset(index)` korzysta z indeksu zmierzonych i szacowanych wysokości.

`scrollToRow(index, { align: "start", smooth: true })` zaczyna od szacowanego
offsetu, montuje wiersz i koryguje pozycję przez istniejącą kotwicę pomiarową.
Dodatkowa przestrzeń końcowa pozwala wyrównać także ostatnie wejście do góry.
„Jump to latest” usuwa ją i przywraca śledzenie końca. Gest czytelnika lub inna
nawigacja anuluje oczekującą korektę.

`scrollRowToTop(key)` pozostaje osobną operacją zakończenia odpowiedzi: działa
wyłącznie dla zamontowanego wiersza i czytelnika przy końcu. Nie służy do skoków
do tur odmontowanych przez wirtualizację. Reduced motion wyłącza smooth scroll,
przejścia kresek, przesuwanie karty i puls pracy. Interakcja paska, treść podglądu
i model indeksów pozostają osobnymi modułami, współdzieląc `Popover` i `MarkdownSnippet`.
