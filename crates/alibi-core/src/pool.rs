use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// A shielded pool that has its own note commitment tree and therefore its own anchors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pool {
    Sapling,
    Orchard,
    Ironwood,
}

impl Pool {
    pub const ALL: [Pool; 3] = [Pool::Sapling, Pool::Orchard, Pool::Ironwood];

    pub fn as_str(self) -> &'static str {
        match self {
            Pool::Sapling => "sapling",
            Pool::Orchard => "orchard",
            Pool::Ironwood => "ironwood",
        }
    }

    /// Stable small integer used as a storage key.
    pub fn code(self) -> u8 {
        match self {
            Pool::Sapling => 0,
            Pool::Orchard => 1,
            Pool::Ironwood => 2,
        }
    }

    pub fn from_code(code: u8) -> Option<Pool> {
        match code {
            0 => Some(Pool::Sapling),
            1 => Some(Pool::Orchard),
            2 => Some(Pool::Ironwood),
            _ => None,
        }
    }
}

impl fmt::Display for Pool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Pool {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "sapling" => Ok(Pool::Sapling),
            "orchard" => Ok(Pool::Orchard),
            "ironwood" => Ok(Pool::Ironwood),
            other => Err(format!("unknown pool `{other}` (expected sapling, orchard or ironwood)")),
        }
    }
}
