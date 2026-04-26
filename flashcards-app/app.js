const DEV = {
  VIRAMA: "\u094D",
  KA: "\u0915",
  KHA: "\u0916",
  GA: "\u0917",
  GHA: "\u0918",
  CHA: "\u091A",
  JA: "\u091C",
  TA: "\u0924",
  THA: "\u0925",
  DA: "\u0926",
  DHA: "\u0927",
  PA: "\u092A",
  BA: "\u092C",
  SA: "\u0938",
  SHA: "\u0936",
  RA: "\u0930",
  YA: "\u092F",
  VA: "\u0935"
};

function makeHindiCluster(first, second, label) {
  return {
    main: first + DEV.VIRAMA + second,
    sub: label || ""
  };
}

function generateHindiClusters() {
  const pairs = [
    // Combinations with RA (र) as second consonant
    [DEV.KA, DEV.RA, "क्र (kra)"],
    [DEV.KHA, DEV.RA, "ख्र (khra)"],
    [DEV.GA, DEV.RA, "ग्र (gra)"],
    [DEV.GHA, DEV.RA, "घ्र (ghra)"],
    [DEV.CHA, DEV.RA, "च्र (chra)"],
    [DEV.TA, DEV.RA, "त्र (tra)"],
    [DEV.THA, DEV.RA, "थ्र (thra)"],
    [DEV.DA, DEV.RA, "द्र (dra)"],
    [DEV.DHA, DEV.RA, "ध्र (dhra)"],
    [DEV.PA, DEV.RA, "प्र (pra)"],
    [DEV.BA, DEV.RA, "ब्र (bra)"],
    [DEV.SHA, DEV.RA, "श्र (shra)"],
    [DEV.SA, DEV.RA, "स्र (sra)"],
    [DEV.VA, DEV.RA, "व्र (vra)"],
    
    // Combinations with YA (य) as second consonant
    [DEV.KA, DEV.YA, "क्य (kya)"],
    [DEV.KHA, DEV.YA, "ख्य (khya)"],
    [DEV.GA, DEV.YA, "ग्य (gya)"],
    [DEV.GHA, DEV.YA, "घ्य (ghya)"],
    [DEV.CHA, DEV.YA, "च्य (chya)"],
    [DEV.JA, DEV.YA, "ज्य (jya)"],
    [DEV.TA, DEV.YA, "त्य (tya)"],
    [DEV.THA, DEV.YA, "थ्य (thya)"],
    [DEV.DA, DEV.YA, "द्य (dya)"],
    [DEV.DHA, DEV.YA, "ध्य (dhya)"],
    [DEV.PA, DEV.YA, "प्य (pya)"],
    [DEV.BA, DEV.YA, "ब्य (bya)"],
    [DEV.SHA, DEV.YA, "श्य (shya)"],
    [DEV.SA, DEV.YA, "स्य (sya)"],
    [DEV.VA, DEV.YA, "व्य (vya)"],
    
    // Combinations with VA (व) as second consonant
    [DEV.KA, DEV.VA, "क्व (kva)"],
    [DEV.KHA, DEV.VA, "ख्व (khva)"],
    [DEV.GA, DEV.VA, "ग्व (gva)"],
    [DEV.GHA, DEV.VA, "घ्व (ghva)"],
    [DEV.JA, DEV.VA, "ज्व (jva)"],
    [DEV.TA, DEV.VA, "त्व (tva)"],
    [DEV.THA, DEV.VA, "थ्व (thva)"],
    [DEV.DA, DEV.VA, "द्व (dva)"],
    [DEV.DHA, DEV.VA, "ध्व (dhva)"],
    [DEV.PA, DEV.VA, "प्व (pva)"],
    [DEV.SHA, DEV.VA, "श्व (shva)"],
    [DEV.SA, DEV.VA, "स्व (sva)"],
    
    // Combinations with TA (त) as second consonant
    [DEV.KA, DEV.TA, "क्त (kta)"],
    [DEV.KHA, DEV.TA, "ख्त (khta)"],
    [DEV.GA, DEV.TA, "ग्त (gta)"],
    [DEV.GHA, DEV.TA, "घ्त (ghta)"],
    [DEV.CHA, DEV.TA, "च्त (chta)"],
    [DEV.JA, DEV.TA, "ज्त (jta)"],
    [DEV.PA, DEV.TA, "प्त (pta)"],
    [DEV.BA, DEV.TA, "ब्त (bta)"],
    [DEV.SHA, DEV.TA, "श्त (shta)"],
    [DEV.SA, DEV.TA, "स्त (sta)"],
    
    // Combinations with THA (थ) as second consonant
    [DEV.KA, DEV.THA, "क्थ (ktha)"],
    [DEV.GA, DEV.THA, "ग्थ (gtha)"],
    [DEV.PA, DEV.THA, "प्थ (ptha)"],
    [DEV.SA, DEV.THA, "स्थ (stha)"]
  ];

  return pairs.map(([a, b, label]) => makeHindiCluster(a, b, label));
}

const languages = {
  english: {
    label: "English",
    letters: [
      { main: "A", sub: "Apple" },
      { main: "B", sub: "Ball" },
      { main: "C", sub: "Cat" },
      { main: "D", sub: "Dog" },
      { main: "E", sub: "Elephant" },
      { main: "F", sub: "Fish" },
      { main: "G", sub: "Grapes" },
      { main: "H", sub: "House" },
      { main: "I", sub: "Ice" },
      { main: "J", sub: "Juice" },
      { main: "K", sub: "Kite" },
      { main: "L", sub: "Lion" },
      { main: "M", sub: "Moon" },
      { main: "N", sub: "Nest" },
      { main: "O", sub: "Orange" },
      { main: "P", sub: "Parrot" },
      { main: "Q", sub: "Queen" },
      { main: "R", sub: "Rabbit" },
      { main: "S", sub: "Sun" },
      { main: "T", sub: "Tree" },
      { main: "U", sub: "Umbrella" },
      { main: "V", sub: "Van" },
      { main: "W", sub: "Whale" },
      { main: "X", sub: "Xylophone" },
      { main: "Y", sub: "Yarn" },
      { main: "Z", sub: "Zebra" }
    ],
    vyanjan: [
      { main: "B", sub: "Ball" },
      { main: "C", sub: "Cat" },
      { main: "D", sub: "Dog" },
      { main: "F", sub: "Fish" },
      { main: "G", sub: "Grapes" },
      { main: "H", sub: "House" },
      { main: "J", sub: "Juice" },
      { main: "K", sub: "Kite" },
      { main: "L", sub: "Lion" },
      { main: "M", sub: "Moon" },
      { main: "N", sub: "Nest" },
      { main: "P", sub: "Parrot" },
      { main: "Q", sub: "Queen" },
      { main: "R", sub: "Rabbit" },
      { main: "S", sub: "Sun" },
      { main: "T", sub: "Tree" },
      { main: "V", sub: "Van" },
      { main: "W", sub: "Whale" },
      { main: "X", sub: "Xylophone" },
      { main: "Y", sub: "Yarn" },
      { main: "Z", sub: "Zebra" }
    ],
    words: [
      { main: "Cat", sub: "A small pet animal" },
      { main: "Sun", sub: "The star that gives us light" },
      { main: "Tree", sub: "A tall plant" },
      { main: "Water", sub: "We drink it" },
      { main: "Book", sub: "We read it" }
    ]
  },
  hindi: {
    label: "Hindi (हिन्दी)",
    letters: [
      { main: "अ", sub: "अनार (pomegranate)" },
      { main: "आ", sub: "आम (mango)" },
      { main: "इ", sub: "इमली (tamarind)" },
      { main: "ई", sub: "ईख (sugarcane)" },
      { main: "उ", sub: "उल्लू (owl)" },
      { main: "ए", sub: "एक (one)" },
      { main: "ओ", sub: "ओखली (mortar)" }
    ],
    vyanjan: [
      { main: "क", sub: "कमल (lotus)" },
      { main: "ख", sub: "खरगोश (rabbit)" },
      { main: "ग", sub: "गाय (cow)" },
      { main: "घ", sub: "घर (house)" },
      { main: "च", sub: "चिड़िया (bird)" },
      { main: "छ", sub: "छाता (umbrella)" },
      { main: "ज", sub: "जहाज (ship)" },
      { main: "झ", sub: "झंडा (flag)" },
      { main: "ट", sub: "टमाटर (tomato)" },
      { main: "ठ", sub: "ठेला (cart)" },
      { main: "ड", sub: "डमरू (drum)" },
      { main: "ढ", sub: "ढोल (drum)" },
      { main: "त", sub: "तरबूज (watermelon)" },
      { main: "थ", sub: "थाली (plate)" },
      { main: "द", sub: "दाल (lentils)" },
      { main: "ध", sub: "धनुष (bow)" },
      { main: "न", sub: "नदी (river)" },
      { main: "प", sub: "पतंग (kite)" },
      { main: "फ", sub: "फल (fruit)" },
      { main: "ब", sub: "बटन (button)" },
      { main: "भ", sub: "भालू (bear)" },
      { main: "म", sub: "मछली (fish)" },
      { main: "य", sub: "यज्ञ (ritual)" },
      { main: "र", sub: "रस (juice)" },
      { main: "ल", sub: "लड्डू (sweet)" },
      { main: "व", sub: "वृक्ष (tree)" },
      { main: "श", sub: "शेर (lion)" },
      { main: "ष", sub: "षट (six)" },
      { main: "स", sub: "समुद्र (sea)" },
      { main: "ह", sub: "हाथी (elephant)" },
      ...generateHindiClusters()
    ],
    words: [
      { main: "घर", sub: "Home" },
      { main: "फल", sub: "Fruit" },
      { main: "फूल", sub: "Flower" },
      { main: "पानी", sub: "Water" },
      { main: "किताब", sub: "Book" }
    ]
  },
  tamil: {
    label: "Tamil (தமிழ்)",
    letters: [
      { main: "அ", sub: "அன்னம் (swan)" },
      { main: "ஆ", sub: "ஆடு (goat)" },
      { main: "இ", sub: "இலை (leaf)" },
      { main: "ஈ", sub: "ஈ (fly)" },
      { main: "உ", sub: "உடல் (body)" },
      { main: "எ", sub: "எலி (rat)" },
      { main: "ஓ", sub: "ஓடம் (boat)" },
      { main: "க", sub: "கல் (stone)" },
      { main: "ச", sub: "சரம் (string)" },
      { main: "ட", sub: "டப்பா (box)" },
      { main: "த", sub: "தலை (head)" },
      { main: "ப", sub: "பல் (tooth)" }
    ],
    vyanjan: [
      { main: "க", sub: "குடம் (pot)" },
      { main: "ங", sub: "மாங்காய் (mango)" },
      { main: "ச", sub: "சக்கரம் (wheel)" },
      { main: "ஞ", sub: "ஞாயிறு (Sunday/sun)" },
      { main: "ட", sub: "டம்ளர் (tumbler)" },
      { main: "ண", sub: "அண்ணன் (elder brother)" },
      { main: "த", sub: "தட்டு (plate)" },
      { main: "ந", sub: "நரி (fox)" },
      { main: "ப", sub: "பந்து (ball)" },
      { main: "ம", sub: "மீன் (fish)" },
      { main: "ய", sub: "யானை (elephant)" },
      { main: "ர", sub: "ரதம் (chariot)" },
      { main: "ல", sub: "லட்டு (sweet)" },
      { main: "வ", sub: "வண்டி (cart)" },
      { main: "ழ", sub: "தமிழ் (Tamil)" },
      { main: "ள", sub: "பள்ளி (school)" },
      { main: "ற", sub: "காற்று (wind)" },
      { main: "ன", sub: "மணல் (sand)" }
    ],
    words: [
      { main: "மரம்", sub: "Tree" },
      { main: "நீர்", sub: "Water" },
      { main: "மனை", sub: "House" },
      { main: "பூ", sub: "Flower" },
      { main: "நாய்", sub: "Dog" }
    ]
  },
  kannada: {
    label: "Kannada (ಕನ್ನಡ)",
    letters: [
      { main: "ಅ", sub: "ಅಕ್ಕಿ (rice)" },
      { main: "ಆ", sub: "ಆನೆ (elephant)" },
      { main: "ಇ", sub: "ಇಲಿ (rat)" },
      { main: "ಈ", sub: "ಈಚಲು (onion)" },
      { main: "ಉ", sub: "ಉಪ್ಪು (salt)" },
      { main: "ಊ", sub: "ಊರು (village)" },
      { main: "ಋ", sub: "ಋತು (season)" },
      { main: "ಎ", sub: "ಎಮ್ಮೆ (buffalo)" },
      { main: "ಏ", sub: "ಏಣು (ladder)" },
      { main: "ಐ", sub: "ಐದು (five)" },
      { main: "ಒ", sub: "ಒಂಟೆ (camel)" },
      { main: "ಓ", sub: "ಓಡ (tile)" },
      { main: "ಔ", sub: "ಔಷಧ (medicine)" }
    ],
    vyanjan: [
      { main: "ಕ", sub: "ಕಮಲ (lotus)" },
      { main: "ಖ", sub: "ಖಗ (bird)" },
      { main: "ಗ", sub: "ಗಜ (elephant)" },
      { main: "ಘ", sub: "ಘಟ (pot)" },
      { main: "ಙ", sub: "ಅಂಗ (body)" },
      { main: "ಚ", sub: "ಚಂದ್ರ (moon)" },
      { main: "ಛ", sub: "ಛತ್ರಿ (umbrella)" },
      { main: "ಜ", sub: "ಜಲ (water)" },
      { main: "ಝ", sub: "ಝರಿ (waterfall)" },
      { main: "ಞ", sub: "ಜ್ಞಾನ (knowledge)" },
      { main: "ಟ", sub: "ಟೊಮೇಟೊ (tomato)" },
      { main: "ಠ", sub: "ಠಕ್ಕ (knock)" },
      { main: "ಡ", sub: "ಡಬ್ಬಿ (box)" },
      { main: "ಢ", sub: "ಢಕ್ಕೆ (drum)" },
      { main: "ಣ", sub: "ಗಣ (group)" },
      { main: "ತ", sub: "ತೆಂಗು (coconut)" },
      { main: "ಥ", sub: "ಥಟ್ಟೆ (plate)" },
      { main: "ದ", sub: "ದೀಪ (lamp)" },
      { main: "ಧ", sub: "ಧಾನ್ಯ (grain)" },
      { main: "ನ", sub: "ನದಿ (river)" },
      { main: "ಪ", sub: "ಪಕ್ಷಿ (bird)" },
      { main: "ಫ", sub: "ಫಲ (fruit)" },
      { main: "ಬ", sub: "ಬಟನ್ (button)" },
      { main: "ಭ", sub: "ಭಾಲು (bear)" },
      { main: "ಮ", sub: "ಮೀನು (fish)" },
      { main: "ಯ", sub: "ಯಜ್ಞ (ritual)" },
      { main: "ರ", sub: "ರಸ (juice)" },
      { main: "ಲ", sub: "ಲಡ್ಡು (sweet)" },
      { main: "ವ", sub: "ವೃಕ್ಷ (tree)" },
      { main: "ಶ", sub: "ಶಾಲೆ (school)" },
      { main: "ಷ", sub: "ಷಟ್ಕೋಣ (hexagon)" },
      { main: "ಸ", sub: "ಸಮುದ್ರ (sea)" },
      { main: "ಹ", sub: "ಹಾವು (snake)" },
      { main: "ಳ", sub: "ಬಳ್ಳಿ (vine)" },
      { main: "ೞ", sub: "ತುಂಬೞಿ (dragonfly)" }
    ],
    words: [
      { main: "ಮನೆ", sub: "Home" },
      { main: "ಹಣ್ಣು", sub: "Fruit" },
      { main: "ಹೂವು", sub: "Flower" },
      { main: "ನೀರು", sub: "Water" },
      { main: "ಪುಸ್ತಕ", sub: "Book" },
      { main: "ಸೂರ್ಯ", sub: "Sun" },
      { main: "ಮರ", sub: "Tree" }
    ]
  }
};

function generateOneMathCard(op) {
  let a, b, question, answer;
  switch (op) {
    case "addition":
      a = Math.floor(Math.random() * 50) + 1;
      b = Math.floor(Math.random() * 50) + 1;
      question = a + " + " + b;
      answer = a + b;
      break;
    case "subtraction":
      a = Math.floor(Math.random() * 50) + 10;
      b = Math.floor(Math.random() * a) + 1;
      question = a + " − " + b;
      answer = a - b;
      break;
    case "multiplication":
      a = Math.floor(Math.random() * 12) + 2;
      b = Math.floor(Math.random() * 12) + 2;
      question = a + " × " + b;
      answer = a * b;
      break;
    case "division":
      b = Math.floor(Math.random() * 12) + 2;
      answer = Math.floor(Math.random() * 12) + 1;
      a = b * answer;
      question = a + " ÷ " + b;
      break;
    case "multiply_by": {
      var n = getMultiplyByNumber();
      var repeated = buildRepeatedNumbers(n);
      var pick = repeated[Math.floor(Math.random() * repeated.length)];
      b = Math.floor(Math.random() * 12) + 1;
      question = pick + " × " + b;
      answer = pick * b;
      break;
    }
  }
  return { main: question, sub: "= " + answer };
}

function getMultiplyByNumber() {
  var input = document.getElementById("multiplyByInput");
  var val = parseInt(input ? input.value : "5", 10);
  return val > 0 ? val : 5;
}

function buildRepeatedNumbers(n) {
  var results = [];
  var s = "";
  for (var i = 0; i < 4; i++) {
    s += String(n);
    results.push(parseInt(s, 10));
  }
  return results;
}

function nextMathCard() {
  var ops = ["addition", "subtraction", "multiplication", "division"];
  var op = currentMode === "all"
    ? ops[Math.floor(Math.random() * ops.length)]
    : currentMode;
  return generateOneMathCard(op);
}

const subjects = {
  english: {
    label: "English",
    modes: [
      { value: "letters", label: "Letters" },
      { value: "words", label: "Words" },
      { value: "vyanjan", label: "Vyanjan (Consonants)" },
      { value: "mixed", label: "Mixed consonants" },
      { value: "all", label: "All (Mixed)" }
    ]
  },
  hindi: {
    label: "Hindi (हिन्दी)",
    modes: [
      { value: "letters", label: "Letters" },
      { value: "words", label: "Words" },
      { value: "vyanjan", label: "Vyanjan (Consonants)" },
      { value: "mixed", label: "Mixed consonants" },
      { value: "all", label: "All (Mixed)" }
    ]
  },
  tamil: {
    label: "Tamil (தமிழ்)",
    modes: [
      { value: "letters", label: "Letters" },
      { value: "words", label: "Words" },
      { value: "vyanjan", label: "Vyanjan (Consonants)" },
      { value: "mixed", label: "Mixed consonants" },
      { value: "all", label: "All (Mixed)" }
    ]
  },
  kannada: {
    label: "Kannada (ಕನ್ನಡ)",
    modes: [
      { value: "letters", label: "Letters" },
      { value: "words", label: "Words" },
      { value: "vyanjan", label: "Vyanjan (Consonants)" },
      { value: "mixed", label: "Mixed consonants" },
      { value: "all", label: "All (Mixed)" }
    ]
  },
  maths: {
    label: "Maths",
    modes: [
      { value: "addition", label: "Addition (+)" },
      { value: "subtraction", label: "Subtraction (−)" },
      { value: "multiplication", label: "Multiplication (×)" },
      { value: "division", label: "Division (÷)" },
      { value: "multiply_by", label: "Multiply by N" },
      { value: "all", label: "All (Mixed)" }
    ]
  }
};

function getMixedConsonants(subjectKey) {
  if (subjectKey === "hindi") {
    return generateHindiClusters();
  }

  const lang = languages[subjectKey];
  if (!lang || !Array.isArray(lang.vyanjan)) return [];
  return lang.vyanjan;
}

const subjectSelect = document.getElementById("subjectSelect");
const modeSelect = document.getElementById("modeSelect");
const cardMain = document.getElementById("cardMain");
const cardSub = document.getElementById("cardSub");
const cardEl = document.getElementById("flashcard");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const shuffleBtn = document.getElementById("shuffleBtn");
const progressText = document.getElementById("progressText");

let currentSubjectKey = "hindi";
let currentMode = "letters";
let currentIndex = 0;
let order = [];
let isAnimating = false;
let mathHistory = [];
let mathPosition = -1;
const MATH_HISTORY_MAX = 5;

function initSubjectOptions() {
  Object.entries(subjects).forEach(([key, value]) => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = value.label;
    subjectSelect.appendChild(opt);
  });

  subjectSelect.value = currentSubjectKey;
  updateModeOptions();
}

function updateModeOptions() {
  const subject = subjects[currentSubjectKey];
  if (!subject) return;

  modeSelect.innerHTML = "";
  subject.modes.forEach(function (m) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.label;
    modeSelect.appendChild(opt);
  });

  if (!subject.modes.some(function (m) { return m.value === currentMode; })) {
    currentMode = subject.modes[0].value;
  }
  modeSelect.value = currentMode;

  var multiplyByField = document.getElementById("multiplyByField");
  if (multiplyByField) {
    multiplyByField.style.display =
      (currentSubjectKey === "maths" && currentMode === "multiply_by") ? "" : "none";
  }
}

function isMathMode() {
  return currentSubjectKey === "maths";
}

function getCurrentList() {
  if (isMathMode()) return mathHistory;

  const lang = languages[currentSubjectKey];
  if (!lang) return [];

  if (currentMode === "mixed") {
    return getMixedConsonants(currentSubjectKey);
  }

  if (currentMode === "all") {
    const parts = [];
    if (Array.isArray(lang.letters)) parts.push(...lang.letters);
    if (Array.isArray(lang.vyanjan)) parts.push(...lang.vyanjan);
    if (Array.isArray(lang.words)) parts.push(...lang.words);
    return parts;
  }

  return lang[currentMode] ?? [];
}

function resetMathHistory() {
  mathHistory = [nextMathCard()];
  mathPosition = 0;
}

function mathNext() {
  if (mathPosition < mathHistory.length - 1) {
    mathPosition++;
  } else {
    mathHistory.push(nextMathCard());
    mathPosition = mathHistory.length - 1;
    if (mathHistory.length > MATH_HISTORY_MAX + 1) {
      mathHistory.shift();
      mathPosition--;
    }
  }
}

function mathPrev() {
  if (mathPosition > 0) {
    mathPosition--;
  }
}

function buildOrder() {
  if (isMathMode()) {
    resetMathHistory();
    return;
  }
  const list = getCurrentList();
  order = list.map((_, idx) => idx);
  shuffleOrder();
}

function shuffleOrder() {
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
}

function clampIndex(idx) {
  if (order.length === 0) return 0;
  if (idx < 0) return order.length - 1;
  if (idx >= order.length) return 0;
  return idx;
}

function renderCard() {
  if (isMathMode()) {
    if (!mathHistory.length) {
      cardMain.textContent = "No data";
      cardSub.textContent = "Try another mode or subject";
      progressText.textContent = "0 / 0";
      return;
    }
    const item = mathHistory[mathPosition];
    cardMain.textContent = item.main;
    cardSub.textContent = item.sub ?? "";
    progressText.textContent = "∞";
    return;
  }

  const list = getCurrentList();
  const total = list.length;

  if (!total) {
    cardMain.textContent = "No data";
    cardSub.textContent = "Try another mode or subject";
    progressText.textContent = "0 / 0";
    return;
  }

  currentIndex = clampIndex(currentIndex);
  const itemIndex = order[currentIndex];
  const item = list[itemIndex];

  cardMain.textContent = item.main;
  cardSub.textContent = item.sub ?? "";

  progressText.textContent = `${currentIndex + 1} / ${total}`;
}

function playIntroAnimation() {
  cardEl.classList.remove("card-animate-in", "card-swipe-left", "card-swipe-right");
  void cardEl.offsetWidth;
  cardEl.classList.add("card-animate-in");
}

function onSubjectChange() {
  currentSubjectKey = subjectSelect.value;
  currentIndex = 0;
  updateModeOptions();
  buildOrder();
  renderCard();
  playIntroAnimation();
}

function onModeChange() {
  currentMode = modeSelect.value;
  currentIndex = 0;
  updateModeOptions();
  buildOrder();
  renderCard();
  playIntroAnimation();
}

function runSwipe(direction) {
  if (isAnimating) return;
  if (!isMathMode() && !order.length) return;

  isAnimating = true;
  const className = direction === "left" ? "card-swipe-left" : "card-swipe-right";

  cardEl.classList.remove("card-animate-in", "card-swipe-left", "card-swipe-right");
  void cardEl.offsetWidth;
  cardEl.classList.add(className);

  cardEl.addEventListener(
    "animationend",
    () => {
      cardEl.classList.remove(className);
      if (isMathMode()) {
        if (direction === "left") mathPrev();
        else mathNext();
      } else {
        const delta = direction === "left" ? -1 : 1;
        currentIndex = clampIndex(currentIndex + delta);
      }
      renderCard();
      isAnimating = false;
    },
    { once: true }
  );
}

function onPrev() {
  runSwipe("left");
}

function onNext() {
  runSwipe("right");
}

function onShuffle() {
  if (isMathMode()) {
    resetMathHistory();
    renderCard();
    playIntroAnimation();
    return;
  }
  if (!order.length) return;
  shuffleOrder();
  currentIndex = 0;
  renderCard();
  playIntroAnimation();
}

function initEvents() {
  subjectSelect.addEventListener("change", onSubjectChange);
  modeSelect.addEventListener("change", onModeChange);
  prevBtn.addEventListener("click", onPrev);
  nextBtn.addEventListener("click", onNext);
  shuffleBtn.addEventListener("click", onShuffle);

  var multiplyByInput = document.getElementById("multiplyByInput");
  if (multiplyByInput) {
    multiplyByInput.addEventListener("change", function () {
      if (currentSubjectKey === "maths" && currentMode === "multiply_by") {
        resetMathHistory();
        renderCard();
        playIntroAnimation();
      }
    });
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft") onPrev();
    else if (ev.key === "ArrowRight") onNext();
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("service-worker.js")
        .catch((err) => console.error("SW registration failed", err));
    });
  }
}

function init() {
  initSubjectOptions();
  buildOrder();
  initEvents();
  renderCard();
  playIntroAnimation();
  registerServiceWorker();
}

init();
