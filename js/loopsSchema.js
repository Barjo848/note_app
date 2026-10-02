/* loopsSchema.js — GENERATED from loops.schema.json by tools/sync_schema.py. Do not edit by hand. */
'use strict';

const LOOPS_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://local/note/loops.schema.json",
  "title": "Note loops document (Loop Lab)",
  "description": "A session of candidate drum loops with ratings, machine analysis, imported layers and arrangements (v2). Unknown fields are permitted and preserved.",
  "type": "object",
  "required": [
    "schemaVersion",
    "session",
    "loops"
  ],
  "properties": {
    "schemaVersion": {
      "type": "integer",
      "minimum": 1
    },
    "app": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "version": {
          "type": "string"
        }
      }
    },
    "session": {
      "$ref": "#/$defs/session"
    },
    "loops": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/loop"
      }
    },
    "layers": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/layer"
      }
    },
    "history": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "at",
          "event"
        ],
        "properties": {
          "at": {
            "type": "string"
          },
          "event": {
            "type": "string"
          }
        }
      }
    },
    "arrangements": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/arrangement"
      }
    }
  },
  "$defs": {
    "signature": {
      "description": "drum → { sixteenth position (0-based, as a string key) → median deviation from the grid in ms }",
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "additionalProperties": {
          "type": "number"
        }
      }
    },
    "expectedSet": {
      "type": "object",
      "additionalProperties": {
        "type": "array",
        "items": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "session": {
      "type": "object",
      "required": [
        "bpm"
      ],
      "properties": {
        "name": {
          "type": "string"
        },
        "bpm": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "meterNumerator": {
          "type": "integer",
          "minimum": 1
        },
        "meterDenominator": {
          "type": "integer",
          "enum": [
            1,
            2,
            4,
            8,
            16,
            32
          ]
        },
        "sourceNote": {
          "type": "string"
        },
        "signature": {
          "$ref": "#/$defs/signature"
        },
        "signatureBasis": {
          "type": "string",
          "enum": [
            "session",
            "loop"
          ]
        },
        "expected": {
          "type": "object",
          "properties": {
            "odd": {
              "$ref": "#/$defs/expectedSet"
            },
            "even": {
              "$ref": "#/$defs/expectedSet"
            }
          }
        },
        "thresholds": {
          "type": "object",
          "properties": {
            "tightMs": {
              "type": "number",
              "minimum": 0
            },
            "feelMs": {
              "type": "number",
              "minimum": 0
            },
            "flamMs": {
              "type": "number",
              "minimum": 0
            },
            "dynamicsDb": {
              "type": "number",
              "minimum": 0
            },
            "expectedShare": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "farMs": {
              "type": "number",
              "minimum": 0
            }
          }
        },
        "corePositions": {
          "type": "object",
          "additionalProperties": {
            "type": "array",
            "items": {
              "type": "integer",
              "minimum": 0
            }
          }
        },
        "bandFloorsDb": {
          "type": "object",
          "properties": {
            "low": {
              "type": [
                "number",
                "null"
              ]
            },
            "mid": {
              "type": [
                "number",
                "null"
              ]
            },
            "high": {
              "type": [
                "number",
                "null"
              ]
            }
          }
        },
        "library": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string"
            },
            "path": {
              "type": "string"
            },
            "manifestGeneratedAt": {
              "type": "string"
            },
            "count": {
              "type": "integer"
            }
          }
        }
      }
    },
    "hit": {
      "type": "object",
      "required": [
        "drum",
        "bar",
        "pos",
        "samples"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "drum": {
          "type": "string",
          "enum": [
            "kick",
            "snare",
            "hat",
            "other"
          ]
        },
        "detectedDrum": {
          "type": "string",
          "enum": [
            "kick",
            "snare",
            "hat",
            "other"
          ]
        },
        "bar": {
          "type": "integer",
          "minimum": 1
        },
        "pos": {
          "type": "integer",
          "minimum": 0
        },
        "tSeconds": {
          "type": "number"
        },
        "samples": {
          "type": "integer",
          "minimum": 0
        },
        "devMs": {
          "type": "number"
        },
        "residualMs": {
          "type": [
            "number",
            "null"
          ]
        },
        "levelDb": {
          "type": "number"
        },
        "class": {
          "type": "string",
          "enum": [
            "tight",
            "feel",
            "mistake",
            "extra",
            "ignore"
          ]
        },
        "mistakeType": {
          "type": [
            "string",
            "null"
          ],
          "enum": [
            "late",
            "flam",
            "dynamics",
            "far",
            null
          ]
        },
        "far": {
          "type": "boolean"
        },
        "override": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "object",
              "required": [
                "class"
              ],
              "properties": {
                "class": {
                  "type": "string",
                  "enum": [
                    "tight",
                    "feel",
                    "mistake",
                    "extra",
                    "ignore"
                  ]
                },
                "reason": {
                  "type": "string"
                }
              }
            }
          ]
        }
      }
    },
    "missing": {
      "type": "object",
      "required": [
        "drum",
        "bar",
        "pos"
      ],
      "properties": {
        "drum": {
          "type": "string"
        },
        "bar": {
          "type": "integer",
          "minimum": 1
        },
        "pos": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "machine": {
      "type": "object",
      "properties": {
        "score": {
          "type": [
            "number",
            "null"
          ]
        },
        "consistencyMs": {
          "type": "object",
          "additionalProperties": {
            "type": [
              "number",
              "null"
            ]
          }
        },
        "feelMs": {
          "type": [
            "number",
            "null"
          ]
        },
        "push1andMs": {
          "type": [
            "number",
            "null"
          ]
        },
        "hatSwingMs": {
          "type": [
            "number",
            "null"
          ]
        },
        "mistakes": {
          "type": "object",
          "additionalProperties": {
            "type": "integer",
            "minimum": 0
          }
        },
        "counts": {
          "type": "object"
        },
        "dynamicsSpreadDb": {
          "type": "object",
          "additionalProperties": {
            "type": [
              "number",
              "null"
            ]
          }
        },
        "join": {
          "type": "string",
          "enum": [
            "clean",
            "tail",
            "pushed downbeat",
            "click likely",
            "unknown"
          ]
        },
        "joinDetail": {
          "type": "object"
        }
      }
    },
    "loop": {
      "type": "object",
      "required": [
        "id",
        "fileName",
        "sampleRate",
        "durationSeconds"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "fileName": {
          "type": "string"
        },
        "fingerprint": {
          "type": [
            "string",
            "null"
          ]
        },
        "sampleRate": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "channels": {
          "type": "integer",
          "minimum": 1
        },
        "bitDepth": {
          "type": "integer",
          "minimum": 0
        },
        "durationSeconds": {
          "type": "number",
          "minimum": 0
        },
        "bars": {
          "type": "number",
          "minimum": 0
        },
        "barsExact": {
          "type": "boolean"
        },
        "barRange": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "object",
              "properties": {
                "start": {
                  "type": "integer"
                },
                "end": {
                  "type": "integer"
                }
              }
            }
          ]
        },
        "offsetSamples": {
          "type": "integer"
        },
        "rating": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number",
              "minimum": 0,
              "maximum": 9.9
            }
          ]
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "string"
        },
        "status": {
          "type": "string"
        },
        "ratedAt": {
          "type": [
            "string",
            "null"
          ]
        },
        "machine": {
          "$ref": "#/$defs/machine"
        },
        "hits": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/hit"
          }
        },
        "missing": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/missing"
          }
        },
        "stemVerified": {
          "type": "boolean"
        },
        "rmsDb": {
          "type": "number"
        },
        "seamFeatures": {
          "$ref": "#/$defs/seamFeatures"
        },
        "blind": {
          "type": [
            "boolean",
            "null"
          ],
          "description": "true when the imported score for this loop was hidden at the moment the rating was committed"
        },
        "listens": {
          "type": "integer",
          "minimum": 0
        },
        "skipped": {
          "type": "boolean"
        },
        "myClass": {
          "type": [
            "string",
            "null"
          ],
          "enum": [
            "tight",
            "feel",
            "mistake",
            null
          ]
        },
        "folder": {
          "type": "string"
        },
        "ptStart": {
          "type": [
            "integer",
            "null"
          ]
        },
        "ptEnd": {
          "type": [
            "integer",
            "null"
          ]
        }
      }
    },
    "layer": {
      "type": "object",
      "required": [
        "id",
        "name",
        "loops"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "human",
            "ai",
            "imported"
          ]
        },
        "createdAt": {
          "type": "string"
        },
        "source": {
          "type": [
            "string",
            "null"
          ]
        },
        "signature": {
          "$ref": "#/$defs/signature"
        },
        "loops": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "properties": {
              "score": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "tight": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "loop": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "notes": {
                "type": "string"
              },
              "hits": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/sidecarHit"
                }
              },
              "missing": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/missing"
                }
              }
            }
          }
        }
      }
    },
    "sidecarHit": {
      "type": "object",
      "required": [
        "drum",
        "bar",
        "pos"
      ],
      "properties": {
        "drum": {
          "type": "string",
          "enum": [
            "kick",
            "snare",
            "hat",
            "other"
          ]
        },
        "bar": {
          "type": "integer",
          "minimum": 1
        },
        "pos": {
          "type": "integer",
          "minimum": 0
        },
        "tSeconds": {
          "type": "number"
        },
        "devMs": {
          "type": "number"
        },
        "residualMs": {
          "type": [
            "number",
            "null"
          ]
        },
        "levelDb": {
          "type": "number"
        },
        "class": {
          "type": "string",
          "enum": [
            "tight",
            "feel",
            "mistake",
            "extra",
            "ignore"
          ]
        }
      }
    },
    "claudeSidecar": {
      "type": "object",
      "required": [
        "schemaVersion",
        "loops"
      ],
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "minimum": 1
        },
        "source": {
          "type": "string"
        },
        "createdAt": {
          "type": "string"
        },
        "bpm": {
          "type": "number"
        },
        "signature": {
          "$ref": "#/$defs/signature"
        },
        "loops": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              },
              "fileNameHint": {
                "type": "string"
              },
              "fingerprint": {
                "type": "string"
              },
              "score": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "tight": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "loop": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "notes": {
                "type": "string"
              },
              "hits": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/sidecarHit"
                }
              },
              "missing": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/missing"
                }
              }
            }
          }
        }
      }
    },
    "seamFeatures": {
      "type": "object",
      "description": "Per-loop numbers the Sequence seam analysis needs, computed once from the decoded audio and cached here so arrangements load without audio.",
      "properties": {
        "lastBeatRmsDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "firstBeatRmsDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "lastBeatPeakDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "firstBeatPeakDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "lastBeatHighDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "firstBeatHighDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "hatsPerBar": {
          "type": [
            "number",
            "null"
          ]
        },
        "hatOnBeatShare": {
          "type": [
            "number",
            "null"
          ]
        },
        "tailRmsDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "floorDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "pushedOnsetMs": {
          "type": [
            "number",
            "null"
          ]
        },
        "firstOnsetMs": {
          "type": [
            "number",
            "null"
          ]
        },
        "firstSample": {
          "type": "array",
          "items": {
            "type": "number"
          }
        },
        "lastSample": {
          "type": "array",
          "items": {
            "type": "number"
          }
        }
      }
    },
    "block": {
      "type": "object",
      "required": [
        "id",
        "loopId",
        "repeats"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "loopId": {
          "type": "string",
          "minLength": 1
        },
        "fingerprint": {
          "type": [
            "string",
            "null"
          ]
        },
        "repeats": {
          "type": "integer",
          "minimum": 1,
          "maximum": 64
        },
        "gainDb": {
          "type": "number",
          "minimum": -12,
          "maximum": 12
        },
        "notes": {
          "type": "string"
        }
      }
    },
    "marker": {
      "type": "object",
      "required": [
        "bar",
        "name"
      ],
      "properties": {
        "bar": {
          "type": "integer",
          "minimum": 1
        },
        "name": {
          "type": "string"
        }
      }
    },
    "seam": {
      "type": "object",
      "required": [
        "index",
        "from",
        "to"
      ],
      "properties": {
        "index": {
          "type": "integer",
          "minimum": 0
        },
        "from": {
          "type": "string"
        },
        "to": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "junction",
            "repeat"
          ]
        },
        "atBar": {
          "type": "integer"
        },
        "levelStepDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "peakOutDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "peakInDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "feelStepMs": {
          "type": [
            "number",
            "null"
          ]
        },
        "highStepDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "hatRateChange": {
          "type": [
            "number",
            "null"
          ]
        },
        "pushedDownbeat": {
          "type": "boolean"
        },
        "startsWithOnset": {
          "type": "boolean"
        },
        "tailCut": {
          "type": "boolean"
        },
        "sampleStep": {
          "type": [
            "number",
            "null"
          ]
        },
        "signatureDiff": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "verdict": {
          "type": "string"
        },
        "severity": {
          "type": "string",
          "enum": [
            "green",
            "amber",
            "red",
            "grey"
          ]
        },
        "care": {
          "type": "string"
        },
        "needsAudio": {
          "type": "boolean"
        },
        "lastBeatRmsDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "firstBeatRmsDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "highRelDb": {
          "type": [
            "number",
            "null"
          ]
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "arrangement": {
      "type": "object",
      "required": [
        "id",
        "name",
        "blocks"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string"
        },
        "createdAt": {
          "type": "string"
        },
        "updatedAt": {
          "type": "string"
        },
        "notes": {
          "type": "string"
        },
        "blocks": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/block"
          }
        },
        "markers": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/marker"
          }
        },
        "settings": {
          "type": "object",
          "properties": {
            "seamFadeMs": {
              "type": "number",
              "minimum": 0,
              "maximum": 20
            },
            "levelMatch": {
              "type": "boolean"
            }
          }
        },
        "seams": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/seam"
          }
        }
      }
    },
    "arrangementExport": {
      "type": "object",
      "required": [
        "schemaVersion",
        "kind",
        "arrangement"
      ],
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "minimum": 2
        },
        "kind": {
          "const": "arrangement"
        },
        "app": {
          "type": "object"
        },
        "session": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string"
            },
            "bpm": {
              "type": "number"
            }
          }
        },
        "arrangement": {
          "$ref": "#/$defs/arrangement"
        },
        "loops": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id"
            ],
            "properties": {
              "id": {
                "type": "string"
              },
              "fingerprint": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "fileName": {
                "type": "string"
              },
              "bars": {
                "type": "number"
              },
              "barRange": {
                "anyOf": [
                  {
                    "type": "null"
                  },
                  {
                    "type": "object"
                  }
                ]
              }
            }
          }
        }
      }
    },
    "ratingsExport": {
      "type": "object",
      "required": [
        "schemaVersion",
        "ratings"
      ],
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "minimum": 1
        },
        "app": {
          "type": "string"
        },
        "exportedAt": {
          "type": "string"
        },
        "library": {
          "type": "string"
        },
        "bpm": {
          "type": "number"
        },
        "barConvention": {
          "type": "string"
        },
        "ratings": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id",
              "rating"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              },
              "fingerprint": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "file": {
                "type": "string"
              },
              "bars": {
                "type": "number"
              },
              "ptStart": {
                "type": [
                  "integer",
                  "null"
                ]
              },
              "ptEnd": {
                "type": [
                  "integer",
                  "null"
                ]
              },
              "rating": {
                "type": [
                  "number",
                  "null"
                ],
                "minimum": 0,
                "maximum": 9.9
              },
              "class": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "notes": {
                "type": "string"
              },
              "ratedAt": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "blind": {
                "type": "boolean"
              },
              "listens": {
                "type": "integer"
              },
              "skipped": {
                "type": "boolean"
              },
              "sequenceUse": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          }
        },
        "unrated": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "summary": {
          "type": "object",
          "properties": {
            "rated": {
              "type": "integer"
            },
            "skipped": {
              "type": "integer"
            },
            "meanRating": {
              "type": [
                "number",
                "null"
              ]
            },
            "byLength": {
              "type": "object"
            }
          }
        },
        "comparison": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "object",
              "properties": {
                "claudeLayer": {
                  "type": "string"
                },
                "n": {
                  "type": "integer"
                },
                "spearman": {
                  "type": [
                    "number",
                    "null"
                  ]
                },
                "meanAbsDelta": {
                  "type": [
                    "number",
                    "null"
                  ]
                },
                "perLoop": {
                  "type": "array",
                  "items": {
                    "type": "object"
                  }
                },
                "byLength": {
                  "type": "object"
                },
                "bySection": {
                  "type": "object"
                },
                "biggestMineHigher": {
                  "type": "array"
                },
                "biggestClaudeHigher": {
                  "type": "array"
                }
              }
            }
          ]
        }
      }
    }
  }
};
