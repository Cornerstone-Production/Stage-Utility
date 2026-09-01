// Every integration descriptor the app ships, captured from GET /api/integrations
// on a fresh install. Nothing here is anyone's data: with no config saved, a
// descriptor is only its id, label, help text and placeholders, which live in
// main/services/integration-manager.ts in this repo.
//
// A fixture rather than an import of integration-manager.ts, because importing the
// manager pulls every device provider, the settings store and the secrets store
// into a renderer test and writes to the data directory. integration-descriptors
// .test.ts pins this list against INTEGRATION_IDS — which IS a pure data module,
// kept separate for exactly this — so adding an integration fails that test
// instead of quietly rendering fifteen cards.

export const INTEGRATION_DESCRIPTOR_FIXTURE: IntegrationDescriptor[] = [
  {
    "id": "planning-center",
    "docs": "planning-center",
    "kind": "lineup",
    "label": "Planning Center",
    "description": "Pulls your Planning Center service plans into Stage — the live rundown, item order and pre-service countdown.",
    "configSchema": [
      {
        "key": "appId",
        "label": "App ID",
        "type": "text",
        "placeholder": "your-app-id",
        "help": "Create a Personal Access Token at api.planningcenteronline.com → Developers → Personal Access Tokens. The App ID and Secret are shown there."
      },
      {
        "key": "secret",
        "label": "Secret",
        "type": "password",
        "placeholder": "your-secret",
        "help": "The Secret half of your PCO Personal Access Token. Stored encrypted on this machine."
      },
      {
        "key": "refreshIntervalMin",
        "label": "Refresh interval",
        "type": "select",
        "placeholder": "How often to pull the latest plan from PCO.",
        "help": "How often Stage Utility re-syncs the plan, team roster, and photos from Planning Center. The live on-air countdown updates continuously regardless of this setting.",
        "options": [
          {
            "value": "5",
            "label": "5 minutes"
          },
          {
            "value": "15",
            "label": "15 minutes"
          },
          {
            "value": "30",
            "label": "30 minutes"
          },
          {
            "value": "60",
            "label": "1 hour"
          },
          {
            "value": "120",
            "label": "2 hours"
          }
        ]
      },
      {
        "key": "countdownTarget",
        "label": "Pre-service countdown",
        "type": "select",
        "default": "plan-start",
        "help": "What the countdown counts down to before a service is live. \"Plan start\" matches PCO's green timer (the top of the plan / doors) by counting to the service time minus any pre-service items above a \"service start\"-type header; if no such header exists it uses the service time. \"Service start time\" always counts to the PCO service time.",
        "options": [
          {
            "value": "plan-start",
            "label": "Plan start (matches PCO)"
          },
          {
            "value": "service-time",
            "label": "Service start time"
          }
        ]
      }
    ]
  },
  {
    "id": "wireless",
    "docs": "wireless",
    "kind": "wireless",
    "label": "Wireless Gear",
    "description": "Puts your wireless mics' RF, audio and battery on a stage display, one channel per slot. Shure and Sennheiser receivers.",
    "configSchema": []
  },
  {
    "id": "companion",
    "docs": "companion",
    "kind": "control",
    "label": "Bitfocus Companion",
    "description": "Lets a Bitfocus Companion surface — a Stream Deck — control Stage and read its state. Nothing to set up here: the module dials in, and this row counts the clients attached.",
    "inbound": true,
    "configSchema": []
  },
  {
    "id": "propresenter",
    "docs": "propresenter",
    "kind": "control",
    "label": "ProPresenter",
    "description": "Shows ProPresenter's current and next slide, its section, and slide thumbnails.",
    "configSchema": [
      {
        "key": "name",
        "label": "Name",
        "type": "text",
        "placeholder": "Main (e.g. Auditorium 1)"
      },
      {
        "key": "host",
        "label": "ProPresenter Host",
        "type": "text",
        "placeholder": "192.168.1.100"
      },
      {
        "key": "port",
        "label": "API Port",
        "type": "number",
        "placeholder": "1025"
      },
      {
        "key": "pollMs",
        "label": "Poll interval (ms)",
        "type": "number",
        "placeholder": "500 (lower = snappier, more requests)"
      }
    ]
  },
  {
    "id": "prodcom",
    "docs": "prodcom",
    "kind": "lineup",
    "label": "ProdCom",
    "description": "Puts live production transcription — captions — on a stage display.",
    "configSchema": [
      {
        "key": "host",
        "label": "ProdCom Host",
        "type": "text",
        "placeholder": "192.168.1.201"
      },
      {
        "key": "port",
        "label": "API Port",
        "type": "number",
        "placeholder": "24480"
      },
      {
        "key": "apiKey",
        "label": "API Key",
        "type": "password",
        "placeholder": "(only if Require Authentication is on)"
      }
    ]
  },
  {
    "id": "smaart",
    "docs": "smaart",
    "kind": "control",
    "label": "Smaart (SPL)",
    "description": "Puts FOH sound-level (SPL) readings from Smaart on a stage display.",
    "configSchema": [
      {
        "key": "host",
        "label": "Smaart Host",
        "type": "text",
        "placeholder": "192.168.1.50"
      },
      {
        "key": "port",
        "label": "API Port",
        "type": "number",
        "placeholder": "26000"
      },
      {
        "key": "password",
        "label": "API Password",
        "type": "password",
        "placeholder": "(only if the Smaart API requires authentication)"
      }
    ]
  },
  {
    "id": "obs",
    "docs": "obs",
    "kind": "control",
    "label": "OBS Studio",
    "description": "Shows whether OBS is recording, streaming, or running its virtual camera.",
    "configSchema": [
      {
        "key": "host",
        "label": "OBS Host",
        "type": "text",
        "placeholder": "192.168.1.50"
      },
      {
        "key": "port",
        "label": "WebSocket Port",
        "type": "number",
        "placeholder": "4455"
      },
      {
        "key": "password",
        "label": "Server Password",
        "type": "password",
        "placeholder": "(from OBS → Tools → WebSocket Server Settings)"
      }
    ]
  },
  {
    "id": "reaper",
    "docs": "reaper",
    "kind": "control",
    "label": "REAPER",
    "description": "Shows whether REAPER is recording.",
    "configSchema": [
      {
        "key": "host",
        "label": "REAPER Host",
        "type": "text",
        "placeholder": "192.168.1.50"
      },
      {
        "key": "port",
        "label": "Web Interface Port",
        "type": "number",
        "placeholder": "8080"
      }
    ]
  },
  {
    "id": "pvp",
    "docs": "provideoplayer",
    "kind": "control",
    "label": "ProVideoPlayer",
    "description": "Shows what ProVideoPlayer has on each layer, and lets automation rules fire cues and clear, hide, mute and fade layers. Names, states and times — PVP offers no preview image of any kind.",
    "configSchema": [
      {
        "key": "host",
        "label": "ProVideoPlayer Host",
        "type": "text",
        "placeholder": "192.168.1.50"
      },
      {
        "key": "port",
        "label": "Network API Port",
        "type": "number",
        "default": 50742,
        "help": "From Preferences → Network → Network API. Not the documentation port."
      },
      {
        "key": "https",
        "label": "Use HTTPS",
        "type": "select",
        "options": [
          {
            "value": "off",
            "label": "Off"
          },
          {
            "value": "on",
            "label": "On"
          }
        ],
        "default": "off",
        "help": "Match PVP's own 'Use HTTPS Connection' setting. PVP normally uses a self-signed certificate, which this app will not accept."
      },
      {
        "key": "token",
        "label": "API Token",
        "type": "password",
        "help": "Only if Require Authentication is on in PVP."
      }
    ]
  },
  {
    "id": "resi",
    "docs": "resi",
    "kind": "control",
    "label": "Resi",
    "description": "Shows whether Resi is streaming, wherever the recording widgets appear. Signs in with your Resi account, because Resi's own API cannot see a stream that started on a schedule.",
    "configSchema": [
      {
        "key": "username",
        "label": "Resi Email",
        "type": "text",
        "placeholder": "you@church.org"
      },
      {
        "key": "password",
        "label": "Resi Password",
        "type": "password"
      },
      {
        "key": "encoderIds",
        "label": "Encoders to watch",
        "type": "text",
        "placeholder": "leave blank for all"
      }
    ]
  },
  {
    "id": "youtube",
    "docs": "youtube",
    "kind": "control",
    "label": "YouTube",
    "description": "Shows whether you are live on YouTube and for how long, with the start time YouTube itself reports.",
    "configSchema": [
      {
        "key": "mode",
        "label": "How to check",
        "type": "select",
        "default": "key",
        "options": [
          {
            "value": "key",
            "label": "Public channel"
          },
          {
            "value": "oauth",
            "label": "My broadcasts"
          }
        ],
        "help": "Public channel needs an API key and your channel, and sees anything a viewer could — including whether a Resi restream actually arrived. My broadcasts also sees private and unlisted streams, but needs an OAuth client and a refresh token to look after."
      },
      {
        "key": "apiKey",
        "label": "API key",
        "type": "password",
        "showIf": {
          "key": "mode",
          "equals": "key"
        }
      },
      {
        "key": "channel",
        "label": "Channel",
        "type": "text",
        "placeholder": "@yourchurch or a channel id",
        "showIf": {
          "key": "mode",
          "equals": "key"
        },
        "help": "The channel handle or id. Found in your channel's URL."
      },
      {
        "key": "clientId",
        "label": "OAuth Client ID",
        "type": "text",
        "showIf": {
          "key": "mode",
          "equals": "oauth"
        }
      },
      {
        "key": "clientSecret",
        "label": "OAuth Client Secret",
        "type": "password",
        "showIf": {
          "key": "mode",
          "equals": "oauth"
        }
      },
      {
        "key": "refreshToken",
        "label": "Refresh Token",
        "type": "password",
        "showIf": {
          "key": "mode",
          "equals": "oauth"
        }
      }
    ]
  },
  {
    "id": "osc",
    "docs": "osc",
    "kind": "control",
    "label": "OSC",
    "description": "Adds layout buttons that send OSC to gear on your LAN — consoles, media servers — and reflect that gear's state back.",
    "configSchema": []
  },
  {
    "id": "rosstalk",
    "docs": "rosstalk",
    "kind": "control",
    "label": "RossTalk (Carbonite / Ultrix)",
    "description": "Sends RossTalk commands to Ross gear: custom controls and switching on a Carbonite, routing and salvos on an Ultrix.",
    "configSchema": []
  },
  {
    "id": "sensource",
    "docs": "sensource",
    "kind": "control",
    "label": "SenSource Vea",
    "description": "Brings live attendance and room occupancy from SenSource Vea onto displays and graphs.",
    "configSchema": [
      {
        "key": "clientId",
        "label": "API Client ID",
        "type": "text",
        "placeholder": "(from Vea → API clients)",
        "help": "Create an API client in the Vea web app (Settings → API clients). It gives you an ID + secret — enter both. Stage Utility handles the token exchange for you."
      },
      {
        "key": "clientSecret",
        "label": "API Client Secret",
        "type": "password",
        "placeholder": "(from Vea → API clients)",
        "help": "The Secret half of the Vea API client (created alongside the Client ID in Vea → API clients). Stored encrypted on this machine."
      },
      {
        "key": "apiToken",
        "label": "Static token (optional)",
        "type": "password",
        "placeholder": "(only if your Vea account issues a long-lived token)",
        "help": "Leave blank in the normal case — the client ID + secret above are all you need. Only fill this if your Vea account issues a long-lived token you'd rather use directly."
      },
      {
        "key": "pollSeconds",
        "label": "Poll interval (s)",
        "type": "number",
        "placeholder": "15",
        "default": 15,
        "min": 10,
        "max": 3600,
        "help": "How often Stage asks Vea for the count. Vea's own numbers advance about every 78 seconds, so the interval is the delay Stage adds on top of that: at 15s the count is at worst 15s behind what the Vea dashboard shows. Below 10s buys nothing — the source has not moved. Raise it to cut API calls."
      }
    ]
  },
  {
    "id": "ross-tsl",
    "docs": "ross-tsl",
    "kind": "control",
    "label": "Ross MultiViewer (TSL UMD)",
    "description": "Puts a people count onto a Ross multiviewer tile as on-tile text, over TSL UMD.",
    "configSchema": [
      {
        "key": "host",
        "label": "Switcher Host",
        "type": "text",
        "placeholder": "192.168.1.60"
      },
      {
        "key": "port",
        "label": "TSL Port",
        "type": "number",
        "placeholder": "(TSL UMD input port on the Ross)"
      }
    ]
  },
  {
    "id": "scores",
    "docs": "scores",
    "kind": "control",
    "label": "Live scores",
    "description": "Follows your teams' live scores from ESPN and shows them in the context bar, on Home, and on a stage display.",
    "configSchema": []
  }
];
