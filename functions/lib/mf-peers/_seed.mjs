/**
 * Seed for MfPeersConfig, from peers.approved.json (research session P, approved
 * 2026-10-10). Applied ONLY when the MfPeersConfig tab has no data rows; after
 * that the sheet is the source of truth and the job never overwrites user edits.
 * The research spelled the SBI keys sbi-ret-*; they are normalised here to the
 * MfHoldings job's fundKeys.
 */
export const SEED_ASOF = "2026-10-10";

export const SEED_CATEGORIES = {
  "flexi-cap": {
    "label": "Flexi Cap (SEBI category: Equity - Flexi Cap)",
    "held": {
      "fundKey": "absl-flexi-cap",
      "amc": "Aditya Birla Sun Life AMC Limited",
      "name": "Aditya Birla Sun Life Flexi Cap Fund",
      "directCode": "120564",
      "regularCode": "103166",
      "isin": "INF209K01XX1",
      "launch": "1998-08-17"
    },
    "comparison": null,
    "peers": [
      {
        "amc": "PPFAS Asset Management Pvt. Ltd.",
        "name": "Parag Parikh Flexi Cap Fund",
        "directCode": "122639",
        "regularCode": "122640",
        "isin": "INF879O01027",
        "launch": "2013-05-13",
        "note": "includes overseas equity"
      },
      {
        "amc": "HDFC Asset Management Company Limited",
        "name": "HDFC Flexi Cap Fund",
        "directCode": "118955",
        "regularCode": "101762",
        "isin": "INF179K01UT0",
        "launch": "1994-12-08"
      },
      {
        "amc": "Kotak Mahindra Asset Management Company Limited.",
        "name": "Kotak Flexi Cap Fund",
        "directCode": "120166",
        "regularCode": "112090",
        "isin": "INF174K01LS2",
        "launch": "2009-07-22"
      },
      {
        "amc": "ICICI Prudential Asset Management Company Limited",
        "name": "ICICI Prudential Flexi Cap fund",
        "directCode": "148990",
        "regularCode": "148989",
        "isin": "INF109KC1R14",
        "launch": "2021-06-28"
      },
      {
        "amc": "UTI Asset Mgmt. Co. Ltd.",
        "name": "UTI - Flexi Cap Fund.",
        "directCode": "120662",
        "regularCode": "100669",
        "isin": "INF789F01TC4",
        "launch": "1992-04-20"
      },
      {
        "amc": "SBI Funds Management Limited",
        "name": "SBI FLEXICAP FUND",
        "directCode": "119718",
        "regularCode": "103215",
        "isin": "INF200K01UG1",
        "launch": "2005-08-22"
      },
      {
        "amc": "Franklin Templeton Asset Management (India) Private Limited",
        "name": "Franklin India Flexi Cap Fund",
        "directCode": "118535",
        "regularCode": "100520",
        "isin": "INF090I01FK3",
        "launch": "1994-09-29"
      },
      {
        "amc": "Motilal Oswal Asset Management Company Limited",
        "name": "Motilal Oswal Flexi Cap Fund",
        "directCode": "129046",
        "regularCode": "129048",
        "isin": "INF247L01502",
        "launch": "2014-04-07"
      },
      {
        "amc": "Axis Asset Management Co. Ltd.",
        "name": "Axis Flexi Cap Fund",
        "directCode": "141925",
        "regularCode": "141927",
        "isin": "INF846K01B28",
        "launch": "2017-10-30"
      },
      {
        "amc": "Canara Robeco Asset Management Company Limited",
        "name": "Canara Robeco Flexi Cap Fund",
        "directCode": "118275",
        "regularCode": "101922",
        "isin": "INF760K01EF0",
        "launch": "2003-08-29"
      },
      {
        "amc": "DSP Asset Managers Private Limited",
        "name": "DSP Flexi Cap Fund",
        "directCode": "119076",
        "regularCode": "105875",
        "isin": "INF740K01PI2",
        "launch": "1997-04-04"
      },
      {
        "amc": "Nippon Life India Asset Management Limited",
        "name": "Nippon India Flexi Cap Fund",
        "directCode": "149094",
        "regularCode": "149089",
        "isin": "INF204KC1121",
        "launch": "2021-07-26"
      },
      {
        "amc": "Bandhan AMC Limited",
        "name": "BANDHAN Flexi Cap Fund",
        "directCode": "118424",
        "regularCode": "108594",
        "isin": "INF194K01W62",
        "launch": "2005-09-05"
      },
      {
        "amc": "quant Money Managers Limited",
        "name": "Quant Flexi Cap Fund",
        "directCode": "120843",
        "regularCode": "109830",
        "isin": "INF966L01911",
        "launch": "2008-08-25"
      },
      {
        "amc": "PGIM India Asset Management Private Limite",
        "name": "PGIM India Flexi Cap Fund",
        "directCode": "133839",
        "regularCode": "133836",
        "isin": "INF663L01FF1",
        "launch": "2015-02-11"
      }
    ]
  },
  "small-cap": {
    "label": "Small Cap (SEBI category: Equity - Small Cap)",
    "held": {
      "fundKey": "iti-small-cap",
      "amc": "ITI Asset Management Limited",
      "name": "ITI Small Cap Fund",
      "directCode": "147919",
      "regularCode": "147920",
      "isin": "INF00XX01747",
      "launch": "2020-01-27"
    },
    "comparison": null,
    "peers": [
      {
        "amc": "Nippon Life India Asset Management Limited",
        "name": "Nippon India Small Cap Fund",
        "directCode": "118778",
        "regularCode": "113177",
        "isin": "INF204K01K15",
        "launch": "2010-08-26"
      },
      {
        "amc": "HDFC Asset Management Company Limited",
        "name": "HDFC Small Cap Fund",
        "directCode": "130503",
        "regularCode": "130502",
        "isin": "INF179KA1RW5",
        "launch": "2008-02-11"
      },
      {
        "amc": "SBI Funds Management Limited",
        "name": "SBI SMALL CAP FUND",
        "directCode": "125497",
        "regularCode": "125494",
        "isin": "INF200K01T51",
        "launch": "2009-07-27"
      },
      {
        "amc": "quant Money Managers Limited",
        "name": "Quant Small Cap Fund",
        "directCode": "120828",
        "regularCode": "100177",
        "isin": "INF966L01689",
        "launch": "1996-09-23"
      },
      {
        "amc": "Bandhan AMC Limited",
        "name": "BANDHAN Small Cap Fund",
        "directCode": "147946",
        "regularCode": "147944",
        "isin": "INF194KB1AL4",
        "launch": "2020-02-03"
      },
      {
        "amc": "Axis Asset Management Co. Ltd.",
        "name": "Axis Small Cap Fund",
        "directCode": "125354",
        "regularCode": "125350",
        "isin": "INF846K01K35",
        "launch": "2013-11-11"
      },
      {
        "amc": "DSP Asset Managers Private Limited",
        "name": "DSP Small Cap Fund",
        "directCode": "119212",
        "regularCode": "105989",
        "isin": "INF740K01QD1",
        "launch": "2007-05-04"
      },
      {
        "amc": "Kotak Mahindra Asset Management Company Limited.",
        "name": "Kotak Small Cap Fund",
        "directCode": "120164",
        "regularCode": "102875",
        "isin": "INF174K01KT2",
        "launch": "2004-12-30"
      },
      {
        "amc": "Invesco Asset Management (India) Private Limited",
        "name": "Invesco India Small Cap Fund",
        "directCode": "145137",
        "regularCode": "145139",
        "isin": "INF205K013T3",
        "launch": "2018-10-10"
      },
      {
        "amc": "Franklin Templeton Asset Management (India) Private Limited",
        "name": "Franklin India Small Cap Fund",
        "directCode": "118525",
        "regularCode": "103360",
        "isin": "INF090I01IQ4",
        "launch": "2005-11-16"
      },
      {
        "amc": "Canara Robeco Asset Management Company Limited",
        "name": "Canara Robeco Small Cap Fund",
        "directCode": "146130",
        "regularCode": "146127",
        "isin": "INF760K01JC6",
        "launch": "2019-01-25"
      },
      {
        "amc": "Tata Asset Management Private Limited",
        "name": "Tata Small Cap Fund",
        "directCode": "145206",
        "regularCode": "145208",
        "isin": "INF277K011O1",
        "launch": "2018-10-19"
      },
      {
        "amc": "ICICI Prudential Asset Management Company Limited",
        "name": "ICICI Prudential Small Cap Fund",
        "directCode": "120591",
        "regularCode": "106823",
        "isin": "INF109K015M0",
        "launch": "2007-08-23"
      },
      {
        "amc": "Edelweiss Asset Management Limited",
        "name": "Edelweiss Small Cap Fund",
        "directCode": "146196",
        "regularCode": "146193",
        "isin": "INF754K01JN6",
        "launch": "2019-01-18"
      },
      {
        "amc": "Aditya Birla Sun Life AMC Limited",
        "name": "Aditya Birla Sun Life Small Cap Fund",
        "directCode": "119556",
        "regularCode": "105804",
        "isin": "INF209K01WN4",
        "launch": "2007-04-09"
      }
    ]
  },
  "conglomerate": {
    "label": "Conglomerate / business-group theme (SEBI Thematic; weak comparability)",
    "held": {
      "fundKey": "absl-conglomerate",
      "amc": "Aditya Birla Sun Life AMC Limited",
      "name": "Aditya Birla Sun Life Conglomerate Fund",
      "directCode": "153124",
      "regularCode": "153127",
      "isin": "INF209KC1373",
      "launch": "2024-12-05"
    },
    "comparison": {
      "window": "common-since-2025-10-27",
      "benchmarkProxyCode": "153132",
      "label": "weak comparability",
      "thematicMedian": false
    },
    "peers": [
      {
        "amc": "ICICI Prudential Asset Management Company Limited",
        "name": "ICICI Prudential Conglomerate Fund",
        "directCode": "153867",
        "regularCode": "153865",
        "isin": "INF109K1A427",
        "launch": "2025-10-03",
        "weakMatch": true
      },
      {
        "amc": "Baroda BNP Paribas Asset Management India Private Limited",
        "name": "Baroda BNP Paribas Business Conglomerates Fund",
        "directCode": "153847",
        "regularCode": "153844",
        "isin": "INF251K01VJ6",
        "launch": "2025-09-02",
        "weakMatch": true
      },
      {
        "amc": "Tata Asset Management Private Limited",
        "name": "Tata BSE Select Business Groups Index Fund",
        "directCode": "153132",
        "regularCode": "153134",
        "isin": "INF277KA1DA2",
        "launch": "2024-11-25",
        "note": "passive index fund (BSE Select Business Groups); benchmark proxy, not an active peer",
        "weakMatch": true
      }
    ]
  },
  "retirement-aggressive-hybrid": {
    "label": "Retirement - SBI Aggressive Hybrid Plan peers (equity ~65-80%)",
    "held": {
      "fundKey": "sbi-retirement-aggressive-hybrid",
      "amc": "SBI Funds Management Limited",
      "name": "SBI Retirement Benefit Fund - Aggressive Hybrid Plan",
      "directCode": "148685",
      "regularCode": "148695",
      "isin": "INF200KA1S97",
      "launch": "2021-01-20"
    },
    "comparison": null,
    "peers": [
      {
        "amc": "Aditya Birla Sun Life AMC Limited",
        "name": "Aditya Birla Sun Life Retirement Fund - The 40s Plan",
        "directCode": "146930",
        "regularCode": "146929",
        "isin": "INF209KB1I80",
        "launch": "2019-02-19"
      },
      {
        "amc": "Axis Asset Management Co. Ltd.",
        "name": "Axis Retirement Savings Fund - Aggressive Plan",
        "directCode": "147825",
        "regularCode": "147823",
        "isin": "INF846K01S86",
        "launch": "2019-11-29"
      },
      {
        "amc": "HDFC Asset Management Company Limited",
        "name": "HDFC Retirement Savings Fund - Hybrid-Equity Plan",
        "directCode": "136464",
        "regularCode": "136463",
        "isin": "INF179KB1MH6",
        "launch": "2016-02-05"
      },
      {
        "amc": "Tata Asset Management Private Limited",
        "name": "Tata Retirement Savings Fund - Moderate Plan",
        "directCode": "119255",
        "regularCode": "115943",
        "isin": "INF277K01QN3",
        "launch": "2011-10-07"
      },
      {
        "amc": "ICICI Prudential Asset Management Company Limited",
        "name": "ICICI Prudential Retirement Fund - Hybrid Aggressive Plan",
        "directCode": "146721",
        "regularCode": "146722",
        "isin": "INF109KC1TW4",
        "launch": "2019-02-07"
      }
    ]
  },
  "retirement-aggressive": {
    "label": "Retirement - SBI Aggressive Plan peers (equity ~80-100%)",
    "held": {
      "fundKey": "sbi-retirement-aggressive",
      "amc": "SBI Funds Management Limited",
      "name": "SBI Retirement Benefit Fund - Aggressive Plan",
      "directCode": "148683",
      "regularCode": "148698",
      "isin": "INF200KA1S55",
      "launch": "2021-01-20"
    },
    "comparison": null,
    "peers": [
      {
        "amc": "Aditya Birla Sun Life AMC Limited",
        "name": "Aditya Birla Sun Life Retirement Fund - The 30s Plan",
        "directCode": "146575",
        "regularCode": "146577",
        "isin": "INF209KB1I23",
        "launch": "2019-02-19"
      },
      {
        "amc": "ICICI Prudential Asset Management Company Limited",
        "name": "ICICI Prudential Retirement Fund - Pure Equity Plan",
        "directCode": "146349",
        "regularCode": "146346",
        "isin": "INF109KC1TS2",
        "launch": "2019-02-07"
      },
      {
        "amc": "HDFC Asset Management Company Limited",
        "name": "HDFC Retirement Savings Fund - Equity Plan",
        "directCode": "136094",
        "regularCode": "136090",
        "isin": "INF179KB1MF0",
        "launch": "2016-02-05"
      },
      {
        "amc": "Tata Asset Management Private Limited",
        "name": "Tata Retirement Savings Fund - Progressive Plan",
        "directCode": "119251",
        "regularCode": "115942",
        "isin": "INF277K01QO1",
        "launch": "2011-10-07"
      },
      {
        "amc": "Nippon Life India Asset Management Limited",
        "name": "Nippon India Retirement Fund - Wealth Creation Scheme",
        "directCode": "133568",
        "regularCode": "133565",
        "isin": "INF204KA1B72",
        "launch": "2015-01-22"
      }
    ]
  },
  "retirement-conservative-hybrid": {
    "label": "Retirement - SBI Conservative Hybrid Plan peers (equity ~10-40%)",
    "held": {
      "fundKey": "sbi-retirement-conservative-hybrid",
      "amc": "SBI Funds Management Limited",
      "name": "SBI Retirement Benefit Fund - Conservative Hybrid Plan",
      "directCode": "148690",
      "regularCode": "148692",
      "isin": "INF200KA1T70",
      "launch": "2021-01-20"
    },
    "comparison": null,
    "peers": [
      {
        "amc": "UTI Asset Mgmt. Co. Ltd.",
        "name": "UTI Retirement Fund",
        "directCode": "120766",
        "regularCode": "100682",
        "isin": "INF789F1AA64",
        "launch": "1994-12-26"
      },
      {
        "amc": "ICICI Prudential Asset Management Company Limited",
        "name": "ICICI Prudential Retirement Fund - Hybrid Conservative Plan",
        "directCode": "146716",
        "regularCode": "146717",
        "isin": "INF109KC1UA8",
        "launch": "2019-02-07"
      },
      {
        "amc": "Axis Asset Management Co. Ltd.",
        "name": "Axis Retirement Savings Fund - Conservative Plan",
        "directCode": "147830",
        "regularCode": "147832",
        "isin": "INF846K01T69",
        "launch": "2019-11-29"
      },
      {
        "amc": "Tata Asset Management Private Limited",
        "name": "Tata Retirement Savings Fund - Conservative Plan",
        "directCode": "119256",
        "regularCode": "115944",
        "isin": "INF277K01QM5",
        "launch": "2011-10-07"
      },
      {
        "amc": "HDFC Asset Management Company Limited",
        "name": "HDFC Retirement Savings Fund - Hybrid-Debt Plan",
        "directCode": "136465",
        "regularCode": "136466",
        "isin": "INF179KB1MJ2",
        "launch": "2016-02-05"
      },
      {
        "amc": "Nippon Life India Asset Management Limited",
        "name": "Nippon India Retirement Fund - Income Generation Scheme",
        "directCode": "133569",
        "regularCode": "133572",
        "isin": "INF204KA1C30",
        "launch": "2015-01-22"
      }
    ]
  },
  "retirement-conservative": {
    "label": "Retirement - SBI Conservative Plan peers (equity ~0-20%; very few peers)",
    "held": {
      "fundKey": "sbi-retirement-conservative",
      "amc": "SBI Funds Management Limited",
      "name": "SBI Retirement Benefit Fund - Conservative Plan",
      "directCode": "148688",
      "regularCode": "148696",
      "isin": "INF200KA1T39",
      "launch": "2021-01-20"
    },
    "comparison": null,
    "peers": [
      {
        "amc": "ICICI Prudential Asset Management Company Limited",
        "name": "ICICI Prudential Retirement Fund - Pure Debt Plan",
        "directCode": "146727",
        "regularCode": "146726",
        "isin": "INF109KC1UE0",
        "launch": "2019-02-07",
        "weakMatch": true
      },
      {
        "amc": "Aditya Birla Sun Life AMC Limited",
        "name": "Aditya Birla Sun Life Retirement Fund - The 50s Plus Debt Plan",
        "directCode": "146943",
        "regularCode": "146941",
        "isin": "INF209KB1K03",
        "launch": "2019-02-19",
        "weakMatch": true
      }
    ]
  }
};

/** The conglomerate benchmark twin (Tata BSE Select Business Groups Index Fund Direct). */
export const BENCHMARK_CODES = new Set(['153132', '153134']);

/**
 * AMFI's TER feed spells some schemes differently from AMFI's master. Keyed by
 * DIRECT code (both plans of the scheme use it); value = the feed's scheme name.
 */
export const TER_NAME_ALIAS = {
  147825: 'Axis Retirement Fund - Aggressive Plan',
  147830: 'Axis Retirement Fund - Conservative Plan',
};

/**
 * Direct codes whose scheme is known to have no usable TER row: HDFC and Nippon post
 * nothing to AMFI's feed under the 2026 regime, and the benchmark twin sits in the
 * Index Funds category, which is deliberately not fetched (hundreds of schemes, and a
 * benchmark proxy's TER is not shown). A scheme that is neither name-matched, alias-matched nor listed here
 * is a test failure, so a new gap is never a silent "n/a".
 */
export const KNOWN_NO_TER = new Set([
  // HDFC
  '118955', '130503', '136094', '136464', '136465',
  // Nippon
  '149094', '118778', '133568', '133569',
  // benchmark twin (Index Funds category not fetched)
  '153132',
]);
