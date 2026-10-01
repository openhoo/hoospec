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
    "clientId": "öffentliche-application-id",
    "directory": "hoospec",
    "specDirectory": "features",
    "adrDirectory": "docs/adr"
  },
  "agent": { "url": "" }
}
```

GitLab-Adresse, Projekt und Defaultbranch werden automatisch aus GitLab CI übernommen. Keine weitere CI-Variable und kein PAT sind für den normalen Login erforderlich. Optional kann Hoospec die komplette **öffentliche Konfiguration herunterladen**. Sie enthält keine Zugangsdaten.

`schemaVersion`, Felder und URLs werden beim Build geprüft. Unbekannte Felder wie `clientSecret`, `token` oder `apiKey` werden abgelehnt. `NEXT_PUBLIC_GITLAB_*`-Variablen können öffentliche Einstellungen überschreiben, falls eure Plattform das bevorzugt.

## Rechte und Speicherung

- Das Studio ist an das konfigurierte Projekt gebunden. Es zeigt keinen freien Projektwechsel an.
- Nach dem OAuth-Login prüft es zusätzlich die direkte bzw. geerbte Projektmitgliedschaft. Ein gültiger GitLab-Account allein genügt nicht.
- Mitglieder mit Repository-Leserecht können Specs und ADRs lesen und herunterladen. Ohne Push-Recht am gewählten Branch erscheint **Nur lesen**; manuelle Bearbeitung, Agent, Import und Review-Schreiben sind gesperrt. Gäste benötigen zusätzlich Repository-Leserecht, um Dokumente laden zu können.
- Mitglieder mit Push-Recht können editieren. GitLab überprüft Rollen, Branchschutz und Dateiversionen bei jedem Commit. Hoospec umgeht diese Regeln nicht.
- Access- und Refresh-Tokens bleiben ausschließlich im Arbeitsspeicher. Während der Sitzung erneuert Hoospec OAuth-Tokens; beim Reload folgt eine neue OAuth-Anmeldung mit der bestehenden GitLab-Sitzung. Die Autorisierung erfolgt im Namen der jeweiligen Person.
- `<directory>/workspace.json` ist das kanonische JSON. Bestehende Quellpfade bleiben erhalten; neue Dateien entstehen unter `<directory>/specs/` und `<directory>/adrs/`.
- Der Workspace einschließlich Verlauf darf maximal 16 MB groß sein. Hoospec prüft diese Grenze vor einem Commit, damit ein gespeicherter Stand anschließend lesbar bleibt.
- Ein Autosave schreibt JSON und generierte Dateien atomar mit `[skip ci]`. Änderungen an der Studio-Konfiguration oder Anwendung lösen die normale CI aus.
- Sobald der JSON-Workspace existiert, verwaltet Hoospec diesen Dokumentbestand. Externe Änderungen an generierten Dateien werden vor einem Überschreiben erkannt. Zusätzliche Dokumente über **Dokument importieren** aufnehmen.
- Andere geöffnete Studios sehen gespeicherte Commits durch Polling. Präsenz und die Übertragung noch ungespeicherter Entwürfe gehören zum separaten Node-Server-Modus.

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
| Nur lesen auf `main` | Rolle und **Allowed to push and merge** des geschützten Branches prüfen oder einen freigegebenen Review-Branch wählen. |
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
