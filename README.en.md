# Homey Energy Dashboard

A local, self-hosted energy dashboard for **Homey Pro**. Solar panels, home battery, grid, gas and your energy contract on one clear page, with costs calculated from your own rates. One Docker container, no cloud, no account, no external packages.

> 🇳🇱 [Nederlandse documentatie](README.md). The dashboard itself is available in English and Dutch.

![Dashboard](docs/screenshots/dashboard.png)

## Features

**Live**
- Animated energy flow between solar, battery, home and grid
- Battery: state of charge, charging/discharging and when it will be full or empty (using the solar forecast)
- Chart of the last hour, with values under your mouse or finger
- Costs and savings so far today

**History** (day, week, month, year)
- Generation, consumption, export, import and how self-sufficient you are
- Generation vs. consumption bar chart
- Sankey diagram: where your energy went
- Battery day view with state of charge and cycles
- Heatmap of consumption, generation or grid over the past 4 weeks

**Costs and contract**
- Day and night (peak/off-peak) rates, weekends included
- Fixed costs per day, contract term and monthly instalment
- Annual bill forecast: will you pay extra or get money back?
- For the Netherlands: net metering ("saldering") until 1 January 2027, export fees, the energy tax reduction, Dutch public holidays, and what the end of net metering will cost you, with and without your battery

**Forecast**
- Solar forecast for today and tomorrow (via [forecast.solar](https://forecast.solar)), with the best hours

**For everyone**
- English and Dutch, following your browser language or set manually
- Setup wizard on first start
- Netherlands with all Dutch rules, or any other country with just your own rates (in your own currency)
- Solar panels, home battery, gas and Energy Dongle are all optional

**Homey integration**
- The dashboard keeps Logic variables in Homey for your flows: surplus (W), solar surplus, battery full, battery (%), off-peak rate, cost today and solar tomorrow

![Analyses](docs/screenshots/analyses.png)

## Requirements

- **Homey Pro** (2023 or newer) with your devices: inverter, smart meter or grid meter, optionally a home battery and gas meter
- A server, NAS or Raspberry Pi with **Docker**
- Optional but recommended (Netherlands/Belgium): the **Homey Energy Dongle** with its Local API enabled. Import and export then come straight from the smart meter registers, which is the most accurate

## Installation

```bash
mkdir homey-energie-dashboard && cd homey-energie-dashboard
curl -O https://raw.githubusercontent.com/rikadoo/homey-energie-dashboard/main/docker-compose.yml
mkdir data && sudo chown 1000:1000 data     # the container runs as user 'node' (uid 1000)
# change the password (SETTINGS_PASSWORD) in docker-compose.yml
docker compose up -d
```

Then open `http://<server>:8080`. On first start the **setup wizard** guides you through:

1. Language and country
2. Connecting Homey (address and API key)
3. What you have: solar panels, home battery, gas, Energy Dongle
4. Linking devices (with a suggestion and the current value to check)
5. Your rates (can also be done later)
6. Extras: solar forecast and signals to Homey

![Setup wizard](docs/screenshots/wizard.png)

Everything can be changed later in the settings (gear icon, top right), where you can also restart the wizard.

## Homey API key

Create a key in the Homey web app (my.homey.app) under **Settings → API Keys**:

| Permission | Purpose |
|---|---|
| View devices (`homey.device.readonly`) | Reading values |
| Variables (`homey.logic`) | Only if you use the signals to Homey |

## Sign conventions

| Value | Positive | Negative |
|---|---|---|
| Grid, power | import | export |
| Battery, power | charging | discharging |

If the sign is wrong, enable **Invert**. **Factor** converts units (e.g. `1000` for kW → W).

## Country settings

- **Netherlands:** net metering until 1 January 2027 (peak first or per register), export fees, the energy tax reduction and Dutch public holidays at the off-peak rate.
- **Other country:** only your own rates: day and night rate, export compensation, an optional export fee, gas and fixed costs, in your own currency. The Dutch-specific parts are hidden.

## Reverse proxy

The dashboard listens on port 8080. Example for **Traefik** (file provider):

```yaml
http:
  routers:
    energie:
      rule: "Host(`energy.example.com`)"
      service: energie
      entrypoints: [websecure]
      tls: {}
  services:
    energie:
      loadBalancer:
        servers:
          - url: "http://energie-dashboard:8080"   # container on the same Docker network as Traefik
```

Tip: let Traefik reach the container through the Docker network (as above) rather than via the server's IP; a firewall such as `ufw` often blocks traffic from a container to its own host.

## Updates and backup

```bash
docker compose pull && docker compose up -d
```

Everything worth keeping is in the `data` folder: `config.json` (settings, including the Homey API key) and `energie.db` (all readings, SQLite).

## How it calculates

- Readings every 10 seconds (configurable), stored as one average per minute. Minutes without readings are skipped: it never interpolates across a gap.
- **Import and export** come from the smart meter registers when the Energy Dongle is used; otherwise from measured power, using the day/night hours from your contract.
- **Home consumption** = solar + import − export − battery charging + battery discharging.
- **Impossible battery values** (e.g. delays in a cloud integration) are corrected: charging with more power than solar and grid supply, and (for zero-export batteries) discharging into the grid. The latter check can be disabled in the battery settings.
- **Annual forecast:** measured usage (live and from meter readings), completed with a seasonal profile and optionally last year's usage.

## Privacy and security

- All data stays on your own server. The only outside connection is forecast.solar (only if you enable the solar forecast; it receives your location and panel details).
- Fonts are bundled; no requests to Google.
- Always set `SETTINGS_PASSWORD`: the settings page contains your Homey key. Do not expose the dashboard to the internet without extra protection.

## Limitations

- The Energy Dongle works with DSMR smart meters (Netherlands and Belgium). Elsewhere, grid power comes from another Homey device.
- Outside the Netherlands the cost model is simple: day/night rates, export compensation and fixed costs. Country-specific schemes (such as capacity tariffs) are not included.
- Home batteries connected to Homey through a cloud integration can lag behind. Impossible values are corrected, but an outdated value that is still plausible cannot be detected.
- Costs are an approximation, not a replacement for your energy bill.

## Development

No dependencies: Node.js 22.13 or newer is enough (uses the built-in `node:sqlite`, `fetch` and `WebSocket`).

```bash
DATA_DIR=./data SETTINGS_PASSWORD=test npm start
```

Translations: the Dutch text is the key. Use `t('Dutch text')` in the code and add the English text to `public/lang-en.js`. Missing translations fall back to Dutch. Want to add a language? Create `lang-xx.js` and extend `public/i18n.js`; pull requests are welcome.

## License

MIT, see [LICENSE](LICENSE). Fonts: Bricolage Grotesque and IBM Plex, under the SIL Open Font License 1.1 (see `public/fonts/LICENSE-fonts.txt`).

This project is not affiliated with Athom (Homey) or any energy supplier. Screenshots show demo data.
