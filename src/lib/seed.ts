import type { Workspace } from './types';
import { documentFromSource } from './json-document';

export const seed = {
  revision: 1, activeFileId: 'checkout', changes: [],
  files: [
    { id: 'checkout', filename: 'checkout.feature', version: 1, reviewed: false, source: `@checkout @payments
Feature: Ein Einkauf, der sich einfach anfühlt
  Kundinnen und Kunden können ihren Warenkorb sicher bezahlen.
  Wir machen Kosten transparent und bestätigen jede Bestellung.

  Background: Ein gefüllter Warenkorb
    Given eine Kundin hat einen Artikel im Wert von 49,00 € im Warenkorb
    And sie ist mit ihrem Kundenkonto angemeldet

  @happy-path
  Scenario: Eine Bestellung mit Kreditkarte bezahlen
    Given die Kundin befindet sich an der Kasse
    When sie eine gültige Kreditkarte hinterlegt
    And sie auf "Jetzt bezahlen" klickt
    Then wird die Zahlung erfolgreich abgeschlossen
    And sie sieht eine Bestätigung mit ihrer Bestellnummer
    And sie erhält eine Bestätigung per E-Mail

  @validation
  Scenario: Eine abgelehnte Zahlung verständlich erklären
    Given die Kundin befindet sich an der Kasse
    When ihre Bank die Kreditkartenzahlung ablehnt
    Then sieht sie eine verständliche Fehlermeldung
    And ihr Warenkorb bleibt erhalten
    And sie kann eine andere Zahlungsmethode auswählen

  @shipping
  Scenario Outline: Versandkosten vor der Zahlung anzeigen
    Given der Warenkorb hat einen Wert von <warenwert>
    When die Kundin eine Lieferadresse in Deutschland eingibt
    Then werden Versandkosten von <versandkosten> angezeigt

    Examples:
      | warenwert | versandkosten |
      | 49,00 €   | 4,90 €        |
      | 75,00 €   | 0,00 €        |
` },
    { id: 'onboarding', filename: 'onboarding.feature', version: 1, reviewed: false, source: `@account
Feature: Willkommen im Team
  Neue Teammitglieder sollen sofort gemeinsam arbeiten können.

  Scenario: Einer Einladung folgen
    Given ein Teammitglied hat eine gültige Einladung erhalten
    When es den Einladungslink öffnet
    Then kann es seinen Namen und ein Passwort festlegen
    And es erhält Zugang zum gemeinsamen Workspace

  Scenario: Eine abgelaufene Einladung öffnen
    Given eine Einladung ist seit mehr als sieben Tagen abgelaufen
    When das Teammitglied den Einladungslink öffnet
    Then sieht es einen Hinweis auf die abgelaufene Einladung
    And kann eine neue Einladung anfordern
` },
    { id: 'search', filename: 'search.feature', version: 1, reviewed: false, source: `@discovery
Feature: Das Richtige finden
  Die Suche hilft Kundinnen und Kunden, passende Produkte zu finden.

  Rule: Suchergebnisse passen zur Anfrage
    Scenario: Nach einem verfügbaren Produkt suchen
      Given ein Produkt mit dem Namen "Leinenhemd" ist verfügbar
      When die Kundin nach "Leinenhemd" sucht
      Then erscheint das Produkt in den Suchergebnissen

    Scenario: Keine passenden Produkte finden
      Given kein Produkt passt zur Suchanfrage
      When die Kundin die Suche ausführt
      Then sieht sie einen hilfreichen Hinweis
      And kann ihre Suchanfrage anpassen
` },
  ],
};

export const seedWorkspace: Workspace = {
  ...seed, schemaVersion: 2,
  files: seed.files.map(({ source, ...file }) => ({ ...file, document: documentFromSource(source, file.filename) })),
};
