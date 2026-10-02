# Hoospec als Unterseite eines bestehenden GitLab-Projekts

**Ziel:** `https://eure-pages-url/hoospec/`, mit den Specs und ADRs desselben Projekts und Zugriff ausschließlich für Projektmitglieder. Die bisherige Pages-Website bleibt erhalten.

## Voraussetzungen

- GitLab **17.10 oder neuer** mit GitLab Pages; geprüft auf GitLab CE 19.4.1.
- Ein verfügbarer CI-Runner mit Zugriff auf npm und die verwendeten Container-Images.
- GitLab Pages **Access Control** muss auf der Instanz aktiviert sein. Bei Self Managed ist das eine einmalige Betreiber-Einstellung: `gitlab_pages['access_control'] = true`. Für die Aktivierung braucht es einen Instanzbetreiber; für die normale OAuth-App nicht.
- Ein Maintainer setzt im Zielprojekt unter **Settings → General → Visibility, project features, permissions → Pages** die Sichtbarkeit auf **Only project members**. Gruppenrichtlinien können zusätzliche Einschränkungen vorgeben.
- Für entfernte Instanzen: HTTPS für GitLab und Pages. Der Browser muss beide Dienste erreichen und den Zertifikaten vertrauen.

**Die Pages-Zugriffskontrolle gilt für die gesamte Website des Projekts.** GitLab Pages kann nicht nur `/hoospec/` privat schalten, während die restliche Website öffentlich bleibt. Wenn die bestehende Website öffentlich bleiben muss, braucht das private Studio eine eigene geschützte Bereitstellung. Ein JavaScript-Login allein ersetzt diese Zugriffskontrolle nicht.

## 1. Hoospec in das vorhandene Repository kopieren

Im Hoospec-Checkout:

```sh
npm run install:gitlab -- /pfad/zum/bestehenden/projekt
```

Der Installer legt ausschließlich `tools/hoospec/` an. Er nimmt keine Zugangsdaten, lokalen Workspaces, `node_modules` oder Build-Artefakte mit. Existiert der Zielordner bereits, bricht er ab. Eure vorhandene `.gitlab-ci.yml` wird nicht automatisch geändert.

## 2. Den bestehenden Pages-Job ergänzen

Füge in eurer `.gitlab-ci.yml` das lokale Include hinzu und ergänze den bestehenden Pages-Job:

```yaml
include:
  - local: 'tools/hoospec/.gitlab/integrate.yml'

# Diesen bestehenden Job ergänzen, keinen zweiten konkurrierenden Pages-Job anlegen.
pages:
  stage: deploy
  needs:
    # Bestehende needs-Einträge hier beibehalten!
    - job: hoospec-build
      artifacts: true
  script:
    # Eure bisherigen Website-Build-Schritte bleiben hier stehen.
    - sh tools/hoospec/scripts/attach-pages.sh public
  pages:
    publish: public
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
```

`public` muss dem tatsächlichen Ausgabeverzeichnis eures Website-Builds entsprechen (z. B. `dist`). Der Attach-Schritt gehört **nach** dem bisherigen Website-Build. Das portable Shell-Skript funktioniert auch in Pages-Jobs ohne Node.js, z. B. bei Ruby/Jekyll oder Python/MkDocs.

`hoospec-build` läuft in der eingebauten `.pre`-Stage. Eure Stage-Liste muss dafür nicht erweitert werden. Es baut mit Node 24, prüft Lint, TypeScript und Tests und liefert ein separates Artefakt. Wenn eure Pages-Pipeline eigene `workflow`- oder Branchregeln hat, müssen sie auch `hoospec-build` zulassen. Das Standardtemplate veröffentlicht nur den Defaultbranch.

Der Attach-Schritt ersetzt ausschließlich seinen eigenen, markierten Hoospec-Unterordner. Ist `/hoospec/` bereits durch andere Inhalte belegt, bricht er ab. Setzt dann beim Job `hoospec-build` die Variable `HOOSPEC_PAGES_PATH`, z. B. `reviews/specs`. Der Base Path wird aus `CI_PAGES_URL` plus diesem Unterpfad erzeugt, auch bei klassischen Namespace-URLs und Unique Domains.

> Die eingebettete Variante benötigt genau einen finalen Pages-Job. Das eigenständige `.gitlab-ci.yml` im Hoospec-Quellpaket ist eine Alternative für ein eigenes Studio-Projekt, kein zusätzliches Include für eine bestehende Website.

Falls euer übergeordnetes TypeScript-Projekt alle `**/*.ts` einsammelt, ergänzt `tools/hoospec` in dessen `tsconfig.json` unter `exclude`. Hoospec wird vom eigenen CI-Job mit seiner eigenen TypeScript-Konfiguration gebaut.

## 3. OAuth einmal einrichten

Nach der ersten erfolgreichen Pipeline öffnest du `/hoospec/`. GitLabs Pages-Zugriffskontrolle prüft zunächst deine Projektberechtigung. Hoospec zeigt anschließend einen kurzen Einrichtungsbereich:

1. **OAuth-App in GitLab anlegen** öffnet die Applications-Seite deines eigenen Profils.
2. Name **Hoospec**, Scope **api**, **Confidential deaktivieren**. Die von Hoospec angezeigte vollständige Redirect-URL kopieren. Unterpfad und abschließender Slash müssen genau stimmen.
3. Die öffentliche **Application ID** in Hoospec einfügen und **Mit GitLab anmelden** wählen.

Für diese Benutzer-OAuth-App brauchst du normalerweise keine Instanz-Adminrechte. Hat die Instanz Benutzer-OAuth-Apps deaktiviert, muss der Betreiber eine Anwendung bereitstellen oder diese Funktion freigeben.

Damit alle dieselbe App verwenden, trage nur die öffentliche ID in `tools/hoospec/hoospec.config.json` ein und committe die Datei:

```json
{
  "$schema": "./hoospec.config.schema.json",
  "schemaVersion": 1,
  "gitlab": {
    "clientId": "öffentliche-application-id"
  },
  "paths": {
    "specs": "features",
    "adrs": "docs/adr",
    "workspace": "hoospec"
  },
  "agent": { "url": "" }
}
```

GitLab-Adresse, Projekt und Defaultbranch werden automatisch aus GitLab CI übernommen. Keine weitere CI-Variable und kein PAT sind für den normalen Login erforderlich. Optional kann Hoospec die komplette **öffentliche Konfiguration herunterladen**. Sie enthält keine Zugangsdaten.

`schemaVersion`, Felder und URLs werden beim Build geprüft. Unbekannte Felder wie `clientSecret`, `token` oder `apiKey` werden abgelehnt. `NEXT_PUBLIC_GITLAB_*`-Variablen können öffentliche Einstellungen überschreiben, falls eure Plattform das bevorzugt.

## Ablageorte im Repository

`paths` legt die Verzeichnisse relativ zur **Repository-Wurzel** fest, auch wenn Hoospec unter `tools/hoospec` installiert ist:

| Feld | Verwendung |
| --- | --- |
| `paths.specs` | Bestehende `.feature`-Dateien rekursiv laden; neue Specs hier generieren. |
| `paths.adrs` | Bestehende `.md`- und `.markdown`-ADRs rekursiv laden; neue ADRs hier generieren. |
| `paths.workspace` | Kanonisches JSON mit Verlauf unter `<workspace>/workspace.json`. |

In GitLab CI hat eine `hoospec.config.json` in der Repository-Wurzel Vorrang. Fehlt sie, wird `tools/hoospec/hoospec.config.json` verwendet. Für lokale Pages-Builds aus dem eingebetteten Tool kann `CI_PROJECT_DIR` auf die Repository-Wurzel gesetzt werden. Bei einer Konfiguration an der Wurzel ist `$schema` optional oder zeigt auf `./tools/hoospec/hoospec.config.schema.json`.

Änderungen an der Konfiguration benötigen einen neuen Pages-Build. Bestehende Dokumente im JSON behalten ihre gespeicherten Pfade; die Konfiguration verschiebt keine Dateien. Ein anderer Workspace-Pfad öffnet einen anderen Dokumentbestand. Sobald der Workspace existiert, wird dessen Bestand geladen; die Verzeichnissuche erfolgt nur beim ersten Laden ohne JSON.

Ein leeres `specs` sucht im gesamten Repository und legt neue Specs an der Wurzel an. Ein leeres `adrs` deaktiviert die ADR-Suche; neue ADRs werden dann an der Wurzel angelegt. `workspace` darf nicht leer sein. Pfade mit `..` sind ungültig. Die bisherigen `gitlab.directory`, `gitlab.specDirectory` und `gitlab.adrDirectory` bleiben kompatibel; widersprüchliche Angaben werden abgelehnt.

## Rechte und Speicherung

- Das Studio ist an das konfigurierte Projekt gebunden. Es zeigt keinen freien Projektwechsel an.
- Nach dem OAuth-Login prüft es zusätzlich die direkte bzw. geerbte Projektmitgliedschaft. Ein gültiger GitLab-Account allein genügt nicht.
- Mitglieder mit Repository-Leserecht können Specs und ADRs lesen und herunterladen. Reporter und andere Mitglieder ohne Entwicklerrechte sehen **Nur lesen**; manuelle Bearbeitung, Agent und Import sind gesperrt. Gäste benötigen zusätzlich Repository-Leserecht, um Dokumente laden zu können.
- Ab der Developer-Rolle können Mitglieder Entwürfe bearbeiten und Merge Requests erstellen, auch wenn der Zielbranch direkte Pushes verbietet. GitLab überprüft Schreibrechte auf dem Entwurfs-Branch, Branchschutz und Dateiversionen bei jedem Commit. Hoospec umgeht diese Regeln nicht.
- Access- und Refresh-Tokens bleiben ausschließlich im Arbeitsspeicher. Während der Sitzung erneuert Hoospec OAuth-Tokens; beim Reload folgt eine neue OAuth-Anmeldung mit der bestehenden GitLab-Sitzung. Die Autorisierung erfolgt im Namen der jeweiligen Person.
- `<directory>/workspace.json` ist das kanonische JSON. Bestehende Quellpfade bleiben erhalten; neue Dateien entstehen unter `paths.specs` bzw. `paths.adrs`.
- Der Workspace einschließlich Verlauf darf maximal 16 MB groß sein. Hoospec prüft diese Grenze vor einem Commit, damit ein gespeicherter Stand anschließend lesbar bleibt.
- Autosave und fertige Agent-Änderungen verändern zunächst nur den lokalen Sitzungsentwurf. Erst **Entwurfs-MR erstellen** schreibt JSON und generierte Dateien in einem atomaren Commit auf einen neuen `hoospec/<workspace-hash>/<session-id>`-Branch und erstellt einen Draft-MR zum konfigurierten Zielbranch. **Änderungen synchronisieren** erzeugt einen weiteren Commit auf demselben MR-Branch. Es gibt keinen separaten Push-Schritt. Commits überspringen CI nicht; die Projektregeln entscheiden, welche Prüfungen laufen.
- Sobald der JSON-Workspace existiert, verwaltet Hoospec diesen Dokumentbestand. Externe Änderungen an generierten Dateien werden vor einem Überschreiben erkannt. Zusätzliche Dokumente über **Dokument importieren** aufnehmen.
- Teammitglieder öffnen unter **Entwürfe → Gemeinsame Entwürfe** denselben MR. Synchronisierte Änderungen erscheinen durch Polling spätestens nach 10 Sekunden bei erreichbarem GitLab. Lokale Eingaben und Präsenz werden in Pages nicht live übertragen; das leistet der separate Node-Server-Modus.

## Entwürfe und Zusammenarbeit

1. Dokumente wie gewohnt bearbeiten. Inline-Autosave, Undo/Redo und der Agent arbeiten im lokalen Entwurf; es entsteht noch kein Commit.
2. Oben **Änderungen** öffnen, Dateidiffs prüfen und einen aussagekräftigen MR-Titel eingeben.
3. **Entwurfs-MR erstellen** legt den Branch mit einem atomaren Commit und den Draft-MR an. Erst danach ist der Entwurf für das Team gespeichert. Im Dialog bleibt der GitLab-Link sichtbar.
4. Andere Mitglieder öffnen denselben MR unter **Entwürfe → Gemeinsame Entwürfe**. Weitere Bearbeitungen bewusst mit **Änderungen synchronisieren** teilen; pro Synchronisierung entsteht ein Commit mit der eingegebenen Nachricht. Es wird derselbe MR weitergeführt.
5. Review, Freigabe, „Ready“ und Merge erfolgen in GitLab unter dessen Projektregeln. Hoospec merged niemals automatisch. Nach Merge oder Schließen wechselt ein Studio ohne lokale Änderungen zurück zum Zielbranch.

### Gleichzeitige Änderungen

Ein geänderter gemeinsamer Branch überschreibt keinen lokalen Entwurf. Solange eigene Änderungen offen sind, zeigt das Studio **Konflikt prüfen** und blockiert die Synchronisierung. Der Dialog bietet zwei direkte Möglichkeiten: **Gemeinsamen Stand verwenden** verwirft den lokalen Entwurf; **Meinen Entwurf behalten** lädt den aktuellen gemeinsamen Stand und überträgt nur die lokal geänderten Dokumente darauf. Die Änderungen bleiben zunächst lokal und können als Diff geprüft werden, bevor **Änderungen synchronisieren** sie teilt. Bei demselben Dokument entscheidet diese Auswahl bewusst für den eigenen kompletten Dokumentstand; es gibt keine automatische Zusammenführung einzelner Sätze.

Lokale Entwürfe werden automatisch in IndexedDB gesichert, getrennt nach GitLab-Instanz, Projekt, Zielbranch, Workspace-Verzeichnis und Browser-Tab. Ein Reload oder eine erneute OAuth-Anmeldung im selben Tab stellt den Entwurf nach erfolgreicher Projektprüfung wieder her. Auch ein ausstehender Commit/MR-Vorgang bleibt wiederholbar. Andere Tabs teilen ausschließlich den synchronisierten MR-Stand. Tokens und Agent-Zugänge bleiben im Arbeitsspeicher; sie werden niemals mit dem Entwurf gespeichert. Ein neu geöffneter Tab startet eine eigene lokale Sitzung. Private Browser-Modi, gelöschte Website-Daten oder ein nicht verfügbarer Browser-Speicher können diese lokale Sicherung verhindern; Hoospec zeigt dann einen Speicherfehler und bestätigt die Eingabe nicht als gespeichert.

Falls GitLab den Commit angenommen hat, aber die MR-Erstellung oder Antwort fehlschlägt, prüft **Erneut versuchen** den vorhandenen Branch und setzt die Einreichung ohne zweiten Commit fort. Ein Draft-MR ist eine GitLab-Arbeitskopie, keine Übernahme in den Zielbranch.

## Optional: AI

Manuelle Bearbeitung und GitLab-Speicherung funktionieren ohne Agent-Dienst. Für AI kann ein Hoospec-Server als separate Bridge betrieben werden. GitLab Pages führt keinen Node-Server aus.

Serverseitig setzen:

```dotenv
HOOSPEC_AI_BASE_URL=https://euer-gateway.example/v1
HOOSPEC_AI_MODEL=modellname
HOOSPEC_AI_KEY=<serverseitiges-secret>
HOOSPEC_PAGES_ORIGIN=https://eure-pages-origin.example
HOOSPEC_REPOSITORY_AGENT_TOKEN=<separates-secret-mit-mindestens-32-zeichen>
```

`HOOSPEC_PAGES_ORIGIN` enthält **keinen Unterpfad**. Die vollständige URL des `/api/repository-agent`-Endpunkts kann in `agent.url` stehen. Den separaten Bridge-Zugang gibt ein Nutzer nur für seine aktuelle Sitzung unter **Verbindungseinstellungen** ein. Der Bridge-Schlüssel gehört niemals in die öffentliche Konfiguration. Die Bridge erhält ausschließlich das ausgewählte Dokument und den Änderungswunsch; das Schreiben erfolgt im Browser über die GitLab-Berechtigung des Nutzers.

Die Bridge ersetzt nicht die Pages-Zugriffskontrolle. Ein sicher betriebener Bridge-Dienst braucht HTTPS und seinen eigenen geschützten Zugang.

## Wenn etwas nicht funktioniert

| Symptom | Prüfen |
|---|---|
| Private Pages nicht auswählbar | Ist Pages Access Control auf der Instanz aktiviert? Betreiber kontaktieren. |
| Pages meldet 404 oder fehlenden Zugriff | Projektmitgliedschaft, Pages-Sichtbarkeit, ggf. Gruppen-SSO prüfen. |
| OAuth `redirect_uri` ungültig | Exakte URL aus Hoospec registrieren; Unique Domain, Unterpfad und Slash beachten. |
| OAuth-Anmeldung klappt, API nicht erreichbar | GitLab-Adresse, HTTPS/Zertifikate, CORS und Reverse Proxy prüfen. GitLabs API und `/oauth/token` müssen vom Pages-Browser erreichbar sein. |
| Nur lesen | Mindestens Developer-Rolle für Bearbeitung und MR-Erstellung erforderlich. Bei einem gemeinsamen Entwurf zusätzlich den Schutz seines `hoospec/*`-Branches prüfen. Direkte Pushrechte auf `main` sind nicht erforderlich. |
| Hoospec fehlt auf Pages | `needs: hoospec-build` mit Artefakten; Attach-Schritt nach dem Website-Build; richtiges Ausgabeverzeichnis. |
| `_next`-Assets 404 | Tatsächliche `CI_PAGES_URL`, `HOOSPEC_PAGES_PATH` und einen eventuell überschriebenen `NEXT_PUBLIC_BASE_PATH` prüfen. |
| Konkurrierende Änderung | Entwurf bleibt offen; aktuellen Repository-Stand prüfen und Änderung erneut übernehmen. |

## Prüfung und Betrieb

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
```

`npm run test:gitlab` ist ein zusätzlicher Integrationstest gegen eine echte **lokale, disposable** GitLab-Instanz. Er erstellt ein eigenes privates Testprojekt. Setze `HOOSPEC_TEST_GITLAB_TOKEN_FILE` auf eine geschützte Datei mit dem Test-Token; dieser Zugang automatisiert die Testeinrichtung und ist unabhängig vom OAuth-Login normaler Nutzer. Details stehen in [testing.md](testing.md).

Offizielle Referenzen: GitLab-Dokumentation zu **Pages access control**, **OAuth provider / user-owned applications**, **OAuth authorization code with PKCE** und **CI YAML pages.publish**.

## Persönlicher Copilot-Zugang

Die SPA kann zusätzlich zum GitLab-Login ein persönliches GitHub Copilot-Konto verbinden. GitLab bestimmt weiter den Projektzugriff. Copilot wird nur für AI-Anfragen verwendet; es erhält keine GitLab-Zugangsdaten und erzeugt keine Repository-Commits.

GitLab Pages kann den persönlichen Copilot-Zugang **ohne zusätzlichen Server** verwenden. Der vorhandene GitLab-Runner übernimmt einmalig GitHubs OAuth Device Flow; danach fragt die SPA Copilot direkt ab. Jede Person nutzt ihr eigenes Abo.

### Einrichtung auf GitLab Pages

1. Eine **eigene GitHub OAuth App** anlegen und **Enable Device Flow** aktivieren. Die Callback-URL kann auf die Studio-Adresse zeigen. Für diesen Ablauf braucht Hoospec kein Client Secret und verwendet keine fremde App-ID.
2. Die öffentliche Client-ID in `hoospec.config.json` setzen und Pages neu bauen:

   ```json
   { "copilot": { "clientId": "öffentliche-ID-eurer-GitHub-OAuth-App" } }
   ```

   Alternativ: `NEXT_PUBLIC_HOOSPEC_COPILOT_CLIENT_ID`. Die SPA bietet dieses Feld auch unter **Repository-Verbindung → Copilot → Copilot konfigurieren** an.
3. Der aktuelle Include `tools/hoospec/.gitlab/integrate.yml` enthält den Job `hoospec-copilot-login`. Bei eigenständiger Installation enthält die mitgelieferte `.gitlab-ci.yml` denselben Job. Bei einer eigenen Stage-Liste ohne `deploy` im Projekt den Job einer vorhandenen regulären Stage zuordnen, z. B. `hoospec-copilot-login: { stage: test }`. `.pre` ist hierfür ungeeignet: GitLab verwirft eine Pipeline, die ausschließlich `.pre`-Jobs enthält. Durch `needs: []` startet der Login trotzdem unmittelbar. Ein vorhandener Runner muss das Node-24-Image ausführen und GitHub erreichen können. Der Job läuft ohne npm-Installation und nur als API-Pipeline auf dem Defaultbranch.
4. Unter **Settings → CI/CD → Variables → Minimum role to use pipeline variables** die vorgesehene Rolle zulassen (z. B. Developer). Für den Login werden nur die öffentliche App-ID, ein öffentlicher Browser-Schlüssel und eine zufällige Sitzungskennung als Pipeline-Variablen übergeben. Projekt-Maintainer richten dies ein; GitLab-Instanzadministratorrechte sind dafür nicht erforderlich. Geschützte Branches können zusätzliche Pipeline-Berechtigungen verlangen.
5. Falls das bestehende Projekt `workflow: rules` einschränkt, diese Regel **vor** den bisherigen Regeln ergänzen und sie auf Projektebene erlauben:

   ```yaml
   workflow:
     rules:
       - if: '$HOOSPEC_COPILOT_LOGIN == "1" && $CI_PIPELINE_SOURCE == "api" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
       # bisherige Regeln beibehalten
   ```

   Normale Build-, Deploy- und Pages-Jobs sollten Login-Pipelines überspringen. Diese Regel jeweils **vor** ihren bisherigen Job-Regeln ergänzen; Jobs mit `only/except` zuerst in gleichwertige `rules` umstellen:

   ```yaml
   rules:
     - if: '$HOOSPEC_COPILOT_LOGIN == "1"'
       when: never
     # bisherige Regeln beibehalten
   ```

   Der Hoospec-Build und die eigenständige Pages-Pipeline überspringen Login-Pipelines bereits. Bei bestehenden Pages-`needs` müssen abhängige Jobs ebenfalls übersprungen werden, damit die Pipeline gültig bleibt. Der Login löst weder einen Commit noch ein Deployment aus.

### Verwendung und Sicherheit

Nach dem GitLab-Login **Mit Copilot verbinden** wählen. Hoospec startet den Runner, zeigt den GitHub-Code und wartet auf deine Bestätigung. Danach erscheint die Modellauswahl; der Inline-Agent nutzt die direkte Copilot-Verbindung. **Abbrechen** beendet eine laufende Anmeldung. **Copilot trennen** entfernt den Zugang aus dem Arbeitsspeicher; GitLab bleibt verbunden.

Der private Entschlüsselungsschlüssel existiert nur in der initiierenden Browser-Sitzung. Der Runner hält OAuth- und Copilot-Tokens im Arbeitsspeicher und schreibt ausschließlich ein mit RSA-OAEP/SHA-256 und AES-256-GCM verschlüsseltes Artefakt. Die Verschlüsselung bindet es an Projekt, Pipeline und Browser-Sitzung. Im Job-Log steht nur der angezeigte Login-Code, niemals ein OAuth- oder Copilot-Token. CI-Debug-Logging wird für den Login verweigert. Runner und Projekt-CI müssen vertrauenswürdig sein: Sie führen den Token-Austausch aus.

Nach dem Entschlüsseln versucht Hoospec, Log und Artefakt über GitLabs Job-Erase-API zu entfernen. Dafür muss GitLab die Aktion zulassen; andernfalls bleibt nur das verschlüsselte Artefakt mit zehn Minuten deklarierter Aufbewahrung. GitLabs Einstellung **Keep artifacts from most recent successful jobs** kann diese Frist verlängern; bei Bedarf im Projekt deaktivieren. Das Artefakt enthält kein GitHub-OAuth-Token.

Der Browser hält nur den kurzlebigen Copilot-API-Zugang im Arbeitsspeicher. Es gibt keine Speicherung in LocalStorage, IndexedDB oder im Repository. Nach Reload oder Ablauf ist ein neuer Login nötig; Zugangsdaten werden nicht über CI-Variablen erneuert. Die ursprüngliche GitHub-App-Autorisierung kann in GitHub separat widerrufen werden. Dokumentkontext und Änderungswunsch gehen direkt an Copilot. Die bestehende Validierung und Versionsprüfung laufen vor dem Speichern; Änderungen bleiben lokal bis zur ausdrücklichen MR-Synchronisierung.

**Kompatibilitätsgrenze:** Der serverfreie Pfad verwendet Copilots direkten Chat-Endpunkt und `copilot_internal/v2/token`, keine Browser-Version des offiziellen SDKs. Diese Schnittstellen sind kein zugesicherter öffentlicher Copilot-SDK-Vertrag. GitHub kann eigene OAuth-Apps oder einzelne Modelle einschränken; die Integration meldet fehlenden Zugang, statt auf fremde App-IDs auszuweichen. Der reale GitLab-Runner-Ablauf wird mit synthetischen GitHub-/Copilot-Antworten getestet. Eine echte Anmeldung und Inferenz mit eurer eigenen App müssen separat geprüft werden.

### Optionaler SDK-Dienst

Für Installationen, die einen Node-Dienst betreiben, bleibt der alternative offizielle SDK-Pfad verfügbar. `copilot.url` kann auf `https://agent.example.com/api/copilot` zeigen. Am Hoospec-Container `HOOSPEC_COPILOT_CLIENT_ID` (eigene App-ID) und `HOOSPEC_PAGES_ORIGIN` (HTTPS-Origin ohne Pfad) konfigurieren. Wenn `copilot.clientId` gesetzt ist, verwendet die SPA den Runner-Pfad. Ohne diese ID kann sie den optionalen Dienst verwenden.

Der SDK-Dienst hält GitHub-Tokens höchstens eine Stunde im Prozessspeicher; der Browser erhält eine zufällige Sitzungskennung. Er unterstützt einen Prozess. Das SDK startet isoliert, ohne Dateizugriff, Shell-Werkzeuge, MCP oder Projektinstruktionen. Für GitLab Pages ist dieser Dienst nicht erforderlich.
