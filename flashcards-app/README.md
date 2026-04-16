# Language Flashcards App

A beautiful, interactive flashcard application for learning languages with smooth 3D animations.

## Features

- 🎴 Smooth 3D flip animations
- 🌍 Multiple languages (English, Hindi, Tamil, Kannada)
- 🎯 Multiple learning modes (Letters, Words, Consonants, Mixed)
- 🔀 Shuffle functionality
- ⌨️ Keyboard support (Arrow keys to navigate)
- 📱 Fully responsive design
- 💾 Offline support (PWA)

## How to Add More Words

### Option 1: Easy - Edit `words.json`

1. Open `words.json` in any text editor
2. Find the language you want to add words to (e.g., "english", "hindi", "tamil", "kannada")
3. Add new entries to the array with this format:

```json
{ "main": "Rainbow", "sub": "Colorful arc in the sky" }
```

4. Save the file and refresh the app

**Note:** The app currently loads words from `app.js`. To use `words.json` auto-loading, you would need to add fetch logic to app.js.

### Option 2: Edit `app.js` Directly

1. Open `app.js`
2. Search for the language you want (e.g., `hindi: {`)
3. Find the `words` array within that language
4. Add entries in this format:

```javascript
{ main: "Rainbow", sub: "Colorful arc in the sky" }
```

### Option 3: Add a New Language

1. Open `app.js`
2. Find the `languages` object
3. Add a new language entry:

```javascript
spanish: {
  label: "Spanish (Español)",
  letters: [
    { main: "A", sub: "Apple" },
    // ... more letters
  ],
  words: [
    { main: "Gato", sub: "Cat" },
    // ... more words
  ]
}
```

4. The new language will automatically appear in the language selector

## Controls

- **Prev / Next Buttons** or **Arrow Keys**: Navigate through cards
- **Shuffle**: Randomize the order
- **Language Selector**: Change languages
- **Mode Selector**: Switch between Letters, Words, Consonants, etc.

## File Structure

```
flashcards-app/
├── index.html          # Main HTML file
├── styles.css          # Styling and animations
├── app.js              # JavaScript logic
├── words.json          # Word database (reference)
├── manifest.webmanifest
├── service-worker.js   # PWA support
└── README.md          # This file
```

## Customization

### Change Colors
Edit the CSS variables in `styles.css`:
```css
:root {
  --bg: #020617;
  --accent: #38bdf8;
  /* ... more variables */
}
```

### Adjust Animation Speed
Modify these variables in `styles.css`:
```css
--transition-fast: 150ms ease-out;
--transition-med: 260ms cubic-bezier(0.22, 0.61, 0.36, 1);
```

## Browser Support

- Chrome/Edge 88+
- Firefox 85+
- Safari 14+
- Works offline (PWA installed)

## Tips

- Add this page to your home screen for offline access
- Use the shuffle feature to randomize learning
- Mix different modes to practice comprehensively

Enjoy learning! 🌟
