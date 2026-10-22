// Meldingen van de server worden in het Nederlands gemaakt en hier, waar nodig, naar het Engels vertaald.

const EN = [
  [/^Ongeldig adres: (.*)$/, 'Invalid address: $1'],
  [/^Kan geen verbinding maken met de dongle\. Klopt het IP-adres en mag de server het IoT-netwerk bereiken\?$/, 'Cannot connect to the dongle. Is the IP address correct and can the server reach that network?'],
  [/^De dongle heeft al 2 verbindingen \(het maximum\)\. Sluit andere programma's die de Local API gebruiken\.$/, 'The dongle already has 2 connections (the maximum). Close other programs that use the Local API.'],
  [/^De Local API van de dongle staat uit\. Zet hem aan in de Homey-app\.$/, "The dongle's Local API is disabled. Enable it in the Homey app."],
  [/^De dongle weigert de verbinding(.*)\.$/, 'The dongle refuses the connection$1.'],
  [/^De dongle reageert niet\. Klopt het IP-adres en mag de server het IoT-netwerk bereiken\?$/, 'The dongle does not respond. Is the IP address correct and can the server reach that network?'],
  [/^De verbinding met de dongle viel stil; opnieuw verbinden\.$/, 'The connection to the dongle went silent; reconnecting.'],
  [/^Nog geen recente meting van de dongle ontvangen\.$/, 'No recent reading received from the dongle yet.'],
  [/^De meter levert geen waarde voor "(.*)"\.$/, 'The meter does not provide a value for "$1".'],
  [/^Verbonden met de dongle, maar er komen geen meetgegevens binnen\. Zit de dongle goed in de slimme meter\?$/, 'Connected to the dongle, but no meter data is coming in. Is the dongle properly plugged into the smart meter?'],
  [/^Geen verbinding met de dongle\. Klopt het IP-adres en mag de server het IoT-netwerk bereiken\?$/, 'No connection to the dongle. Is the IP address correct and can the server reach that network?'],
  [/^Vul het Homey-adres en de API-sleutel in\.$/, 'Enter the Homey address and API key.'],
  [/^Homey weigert de API-sleutel\. Controleer sleutel en rechten\.$/, 'Homey rejects the API key. Check the key and its permissions.'],
  [/^Homey antwoordt met status (\d+)\.$/, 'Homey responded with status $1.'],
  [/^Vul een URL in\.$/, 'Enter a URL.'],
  [/^De URL antwoordt met status (\d+)\.$/, 'The URL responded with status $1.'],
  [/^Pad "(.*)" niet gevonden in het antwoord\.$/, 'Path "$1" not found in the response.'],
  [/^Kies een Homey-apparaat en meetwaarde\.$/, 'Choose a Homey device and value.'],
  [/^Apparaat "(.*)" heeft geen "(.*)"\.$/, 'Device "$1" has no "$2".'],
  [/^Vul het adres van de Energy Dongle in\.$/, 'Enter the address of the Energy Dongle.'],
  [/^De bron gaf geen getal terug\.$/, 'The source did not return a number.'],
  [/^Bron reageert niet \(time-out\)\.$/, 'Source does not respond (time-out).'],
  [/^Bron niet bereikbaar op het netwerk\.$/, 'Source not reachable on the network.'],
  [/^Homey weigert: geef de API-sleutel ook het recht om Logica \(variabelen\) te beheren\.$/, 'Homey refuses: give the API key the permission to manage Logic (variables).'],
  [/^Homey reageert niet\.$/, 'Homey does not respond.'],
  [/^Variabelen in Homey zijn bijgewerkt\.$/, 'Variables in Homey have been updated.'],
  [/^Nog niet gestart$/, 'Not started yet'],
  [/^Te veel verzoeken bij forecast\.solar, probeer het over een uur opnieuw\.$/, 'Too many requests to forecast.solar, try again in an hour.'],
  [/^forecast\.solar antwoordt met status (\d+)\.$/, 'forecast.solar responded with status $1.'],
  [/^forecast\.solar reageert niet\.$/, 'forecast.solar does not respond.'],
  [/^Vul bij instellingen het vermogen \(kWp\) van je panelen in\.$/, 'Enter the power (kWp) of your panels in the settings.'],
  [/^Verzoek te groot\.$/, 'Request too large.'],
  [/^De meter levert deze waarde niet\.$/, 'The meter does not provide this value.'],
  [/^Niet gevonden$/, 'Not found'],
  [/^Deze meetwaarde staat uit\.$/, 'This value is disabled.'],
];

export function trServer(text, lang) {
  if (lang !== 'en' || typeof text !== 'string') return text;
  for (const [re, rep] of EN) if (re.test(text)) return text.replace(re, rep);
  return text;
}

/** Vertaal de bekende tekstvelden in een API-antwoord. */
export function trBody(body, lang) {
  if (lang !== 'en' || !body || typeof body !== 'object') return body;
  const out = Array.isArray(body) ? body : { ...body };
  for (const k of ['error', 'message']) if (typeof out[k] === 'string') out[k] = trServer(out[k], lang);
  if (out.errors && typeof out.errors === 'object') {
    out.errors = Object.fromEntries(Object.entries(out.errors).map(([k, v]) => [k, trServer(v, lang)]));
  }
  return out;
}

/** Taal voor een verzoek: de ingestelde taal, anders die van de browser. */
export function requestLang(cfg, req) {
  if (cfg.ui.language) return cfg.ui.language;
  return /^nl\b/i.test(String(req.headers['accept-language'] || '')) ? 'nl' : 'en';
}
