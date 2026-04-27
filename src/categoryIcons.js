const KEY = 'budget_category_icons';

export const DEFAULT_ICONS = {
  'Grocery':       '🛒',
  'Eating Out':    '🍽️',
  'Misc':          '📦',
  'Travel':        '✈️',
  'Entertainment': '🎬',
  'Thakkali':      '🏠',
  'Investment':    '📈',
  'Car Payments':  '🚗',
  'Utilities':     '⚡',
  'Utilties':      '⚡',
  'Rent':          '🏠',
  'Health':        '💊',
  'Moving Exp':    '📦',
  'Furniture':     '🛋️',
  'Holiday':       '🏖️',
  'Wi-Fi':         '📡',
};

// Each entry: { e: emoji, k: keywords[] }
export const EMOJI_DATA = [
  // ── Home & Housing ──
  { e: '🏠', k: ['home', 'house', 'rent', 'housing', 'property'] },
  { e: '🏡', k: ['home', 'house', 'garden', 'housing', 'cottage'] },
  { e: '🏢', k: ['office', 'building', 'work', 'corporate'] },
  { e: '🏗️', k: ['construction', 'building', 'renovation', 'repair'] },
  { e: '🛋️', k: ['furniture', 'sofa', 'couch', 'living room'] },
  { e: '🛏️', k: ['bed', 'bedroom', 'sleep', 'furniture'] },
  { e: '🚿', k: ['shower', 'bathroom', 'water', 'hygiene'] },
  { e: '🛁', k: ['bath', 'bathroom', 'tub', 'hygiene'] },
  { e: '🪴', k: ['plant', 'garden', 'home', 'decor'] },
  { e: '🔑', k: ['key', 'rent', 'house', 'lock', 'access'] },
  { e: '🔧', k: ['repair', 'maintenance', 'tool', 'fix', 'plumbing'] },
  { e: '🔨', k: ['hammer', 'repair', 'renovation', 'tool', 'diy'] },
  { e: '🪛', k: ['screwdriver', 'repair', 'tool', 'fix'] },
  { e: '💡', k: ['light', 'electricity', 'utilities', 'bulb', 'idea'] },
  { e: '🕯️', k: ['candle', 'light', 'home', 'decor'] },
  { e: '🧹', k: ['cleaning', 'sweep', 'broom', 'chores', 'home'] },
  { e: '🧺', k: ['laundry', 'cleaning', 'chores', 'washing'] },
  { e: '🪣', k: ['bucket', 'cleaning', 'water', 'chores'] },
  { e: '🧻', k: ['toilet', 'paper', 'bathroom', 'hygiene'] },
  { e: '🪟', k: ['window', 'home', 'house', 'glass'] },
  { e: '🚪', k: ['door', 'home', 'entrance', 'rent'] },

  // ── Utilities & Bills ──
  { e: '⚡', k: ['electricity', 'power', 'utilities', 'energy', 'bill'] },
  { e: '💧', k: ['water', 'utilities', 'bill', 'plumbing'] },
  { e: '🔥', k: ['gas', 'heating', 'utilities', 'fire', 'energy'] },
  { e: '🌡️', k: ['temperature', 'heating', 'cooling', 'utilities', 'hvac'] },
  { e: '📡', k: ['wifi', 'internet', 'cable', 'satellite', 'signal'] },
  { e: '📶', k: ['wifi', 'internet', 'signal', 'network', 'mobile'] },
  { e: '🌐', k: ['internet', 'web', 'online', 'wifi', 'network'] },

  // ── Food & Dining ──
  { e: '🍽️', k: ['dining', 'restaurant', 'eating out', 'food', 'meal', 'plate'] },
  { e: '🥗', k: ['salad', 'healthy', 'food', 'lunch', 'vegetarian'] },
  { e: '🍕', k: ['pizza', 'food', 'italian', 'takeout', 'dining'] },
  { e: '🍔', k: ['burger', 'fast food', 'dining', 'lunch', 'takeout'] },
  { e: '🌮', k: ['taco', 'mexican', 'food', 'dining', 'takeout'] },
  { e: '🍜', k: ['noodles', 'ramen', 'asian', 'food', 'dining'] },
  { e: '🍣', k: ['sushi', 'japanese', 'food', 'dining', 'fish'] },
  { e: '🍱', k: ['bento', 'lunch', 'food', 'meal', 'takeout'] },
  { e: '🥡', k: ['takeout', 'chinese', 'food', 'delivery', 'dining'] },
  { e: '🍰', k: ['cake', 'dessert', 'sweet', 'bakery', 'celebration'] },
  { e: '🧁', k: ['cupcake', 'dessert', 'sweet', 'bakery', 'treat'] },
  { e: '☕', k: ['coffee', 'cafe', 'morning', 'caffeine', 'drinks'] },
  { e: '🧋', k: ['bubble tea', 'drink', 'cafe', 'beverages'] },
  { e: '🍺', k: ['beer', 'drinks', 'alcohol', 'bar', 'pub'] },
  { e: '🍷', k: ['wine', 'alcohol', 'drinks', 'dining', 'bar'] },
  { e: '🥂', k: ['champagne', 'celebration', 'drinks', 'alcohol', 'toast'] },
  { e: '🍸', k: ['cocktail', 'drinks', 'bar', 'alcohol', 'nightlife'] },
  { e: '🧃', k: ['juice', 'drinks', 'beverages', 'healthy'] },
  { e: '🥤', k: ['drink', 'soda', 'beverages', 'takeout', 'fast food'] },

  // ── Groceries & Shopping ──
  { e: '🛒', k: ['grocery', 'shopping', 'cart', 'supermarket', 'food', 'store'] },
  { e: '🛍️', k: ['shopping', 'bags', 'retail', 'store', 'purchase'] },
  { e: '🧴', k: ['lotion', 'skincare', 'hygiene', 'pharmacy', 'personal care'] },
  { e: '🧼', k: ['soap', 'hygiene', 'cleaning', 'personal care', 'bathroom'] },
  { e: '🪥', k: ['toothbrush', 'dental', 'hygiene', 'personal care'] },
  { e: '🧽', k: ['sponge', 'cleaning', 'chores', 'household'] },
  { e: '🫙', k: ['jar', 'pantry', 'grocery', 'food', 'storage'] },
  { e: '🥩', k: ['meat', 'grocery', 'food', 'protein', 'butcher'] },
  { e: '🥦', k: ['vegetables', 'grocery', 'healthy', 'food', 'produce'] },
  { e: '🍎', k: ['fruit', 'apple', 'grocery', 'healthy', 'produce'] },

  // ── Transport ──
  { e: '🚗', k: ['car', 'driving', 'transport', 'vehicle', 'auto', 'payments'] },
  { e: '🚙', k: ['car', 'suv', 'transport', 'vehicle', 'driving'] },
  { e: '⛽', k: ['gas', 'fuel', 'petrol', 'car', 'transport'] },
  { e: '🅿️', k: ['parking', 'car', 'transport', 'fee'] },
  { e: '✈️', k: ['flight', 'travel', 'airplane', 'holiday', 'vacation', 'trip'] },
  { e: '🚌', k: ['bus', 'public transport', 'commute', 'transit'] },
  { e: '🚇', k: ['subway', 'metro', 'transit', 'commute', 'public transport'] },
  { e: '🚂', k: ['train', 'rail', 'commute', 'transit', 'transport'] },
  { e: '🚢', k: ['ship', 'cruise', 'travel', 'vacation', 'ferry'] },
  { e: '🚁', k: ['helicopter', 'travel', 'transport', 'air'] },
  { e: '🛵', k: ['scooter', 'moped', 'transport', 'motorbike'] },
  { e: '🚲', k: ['bike', 'bicycle', 'cycling', 'transport', 'fitness'] },
  { e: '🛴', k: ['scooter', 'electric', 'transport', 'commute'] },
  { e: '🚕', k: ['taxi', 'cab', 'uber', 'transport', 'ride'] },
  { e: '🛻', k: ['truck', 'pickup', 'transport', 'moving', 'vehicle'] },
  { e: '🏎️', k: ['race car', 'sports car', 'fast', 'car', 'vehicle'] },
  { e: '🛞', k: ['tire', 'wheel', 'car', 'maintenance', 'auto'] },

  // ── Finance & Money ──
  { e: '💰', k: ['money', 'savings', 'cash', 'finance', 'wealth'] },
  { e: '💵', k: ['money', 'cash', 'dollar', 'salary', 'income'] },
  { e: '💳', k: ['credit card', 'payment', 'finance', 'debit', 'bank'] },
  { e: '🏦', k: ['bank', 'finance', 'savings', 'money', 'account'] },
  { e: '📈', k: ['investment', 'stocks', 'growth', 'finance', 'market', 'profit'] },
  { e: '📉', k: ['decline', 'loss', 'stocks', 'finance', 'market'] },
  { e: '💹', k: ['forex', 'stocks', 'trading', 'finance', 'investment'] },
  { e: '🪙', k: ['coin', 'money', 'savings', 'cash', 'crypto'] },
  { e: '💎', k: ['diamond', 'luxury', 'investment', 'valuable', 'premium'] },
  { e: '🏧', k: ['atm', 'cash', 'bank', 'withdrawal', 'money'] },
  { e: '🧾', k: ['receipt', 'bill', 'expense', 'purchase', 'invoice'] },
  { e: '📊', k: ['chart', 'budget', 'finance', 'data', 'analytics'] },
  { e: '🔐', k: ['savings', 'locked', 'secure', 'vault', 'investment'] },
  { e: '💸', k: ['spending', 'money', 'expenses', 'cash', 'payment'] },

  // ── Health & Medical ──
  { e: '💊', k: ['medicine', 'pharmacy', 'health', 'pills', 'medication'] },
  { e: '🏥', k: ['hospital', 'medical', 'health', 'doctor', 'emergency'] },
  { e: '🩺', k: ['doctor', 'medical', 'health', 'checkup', 'stethoscope'] },
  { e: '🩹', k: ['bandaid', 'first aid', 'health', 'injury', 'care'] },
  { e: '💉', k: ['injection', 'vaccine', 'medical', 'health', 'shot'] },
  { e: '🧬', k: ['dna', 'science', 'medical', 'health', 'biology'] },
  { e: '🏋️', k: ['gym', 'fitness', 'workout', 'exercise', 'weights', 'health'] },
  { e: '🧘', k: ['yoga', 'meditation', 'wellness', 'health', 'mindfulness'] },
  { e: '🏊', k: ['swimming', 'pool', 'fitness', 'sport', 'exercise'] },
  { e: '🚴', k: ['cycling', 'bike', 'fitness', 'exercise', 'sport'] },
  { e: '🦷', k: ['dental', 'teeth', 'dentist', 'health', 'oral'] },
  { e: '👓', k: ['glasses', 'optician', 'vision', 'health', 'eyewear'] },
  { e: '🧠', k: ['mental health', 'therapy', 'brain', 'wellness', 'psychology'] },

  // ── Entertainment ──
  { e: '🎬', k: ['movies', 'cinema', 'film', 'entertainment', 'netflix', 'streaming'] },
  { e: '🎮', k: ['gaming', 'games', 'playstation', 'xbox', 'entertainment'] },
  { e: '🕹️', k: ['gaming', 'joystick', 'games', 'entertainment', 'arcade'] },
  { e: '🎵', k: ['music', 'spotify', 'entertainment', 'audio', 'songs'] },
  { e: '🎧', k: ['headphones', 'music', 'audio', 'podcast', 'entertainment'] },
  { e: '🎤', k: ['microphone', 'music', 'concert', 'karaoke', 'entertainment'] },
  { e: '🎭', k: ['theatre', 'show', 'performance', 'entertainment', 'arts'] },
  { e: '📺', k: ['tv', 'television', 'streaming', 'entertainment', 'cable'] },
  { e: '📚', k: ['books', 'reading', 'education', 'library', 'knowledge'] },
  { e: '📰', k: ['news', 'newspaper', 'subscription', 'media', 'reading'] },
  { e: '🎨', k: ['art', 'creative', 'painting', 'hobby', 'entertainment'] },
  { e: '🎯', k: ['target', 'goal', 'sports', 'hobby', 'activity'] },
  { e: '🎲', k: ['games', 'board game', 'entertainment', 'hobby', 'fun'] },
  { e: '🃏', k: ['cards', 'games', 'gambling', 'entertainment', 'poker'] },
  { e: '🎪', k: ['circus', 'events', 'entertainment', 'show', 'festival'] },
  { e: '🎡', k: ['carnival', 'amusement', 'park', 'entertainment', 'fun'] },
  { e: '🎢', k: ['rollercoaster', 'theme park', 'fun', 'entertainment', 'amusement'] },

  // ── Technology ──
  { e: '📱', k: ['phone', 'mobile', 'smartphone', 'tech', 'apple', 'android'] },
  { e: '💻', k: ['laptop', 'computer', 'tech', 'work', 'software'] },
  { e: '🖥️', k: ['desktop', 'computer', 'monitor', 'tech', 'work'] },
  { e: '⌨️', k: ['keyboard', 'typing', 'computer', 'tech', 'input'] },
  { e: '🖨️', k: ['printer', 'office', 'tech', 'paper', 'documents'] },
  { e: '📷', k: ['camera', 'photography', 'tech', 'photo', 'hobby'] },
  { e: '🎙️', k: ['microphone', 'podcast', 'recording', 'audio', 'tech'] },
  { e: '📻', k: ['radio', 'audio', 'entertainment', 'music', 'broadcast'] },
  { e: '🔋', k: ['battery', 'power', 'energy', 'electronics', 'charge'] },
  { e: '🔌', k: ['plug', 'power', 'electricity', 'charge', 'electronics'] },
  { e: '💾', k: ['storage', 'data', 'backup', 'computer', 'tech'] },
  { e: '🖱️', k: ['mouse', 'computer', 'tech', 'click', 'input'] },
  { e: '📟', k: ['pager', 'tech', 'communication', 'device'] },
  { e: '⌚', k: ['watch', 'smartwatch', 'apple watch', 'tech', 'wearable'] },

  // ── Travel & Holidays ──
  { e: '🏖️', k: ['beach', 'holiday', 'vacation', 'travel', 'summer'] },
  { e: '🏔️', k: ['mountain', 'hiking', 'travel', 'adventure', 'nature'] },
  { e: '🏕️', k: ['camping', 'outdoors', 'travel', 'nature', 'adventure'] },
  { e: '🗺️', k: ['map', 'travel', 'navigation', 'trip', 'vacation'] },
  { e: '🧳', k: ['luggage', 'travel', 'trip', 'holiday', 'suitcase'] },
  { e: '🏨', k: ['hotel', 'accommodation', 'travel', 'stay', 'airbnb'] },
  { e: '⛩️', k: ['temple', 'japan', 'travel', 'culture', 'tourism'] },
  { e: '🗽', k: ['new york', 'travel', 'tourism', 'sightseeing'] },
  { e: '🎢', k: ['amusement', 'theme park', 'holiday', 'fun', 'travel'] },
  { e: '🌍', k: ['world', 'travel', 'global', 'international', 'earth'] },
  { e: '🗼', k: ['paris', 'france', 'travel', 'tourism', 'eiffel'] },
  { e: '🏝️', k: ['island', 'tropical', 'holiday', 'beach', 'travel'] },
  { e: '⛷️', k: ['skiing', 'winter', 'holiday', 'snow', 'sport'] },
  { e: '🏄', k: ['surfing', 'beach', 'holiday', 'sport', 'ocean'] },
  { e: '🤿', k: ['diving', 'snorkel', 'ocean', 'holiday', 'water sport'] },
  { e: '🎿', k: ['ski', 'winter sport', 'snow', 'holiday'] },
  { e: '🧭', k: ['compass', 'navigation', 'travel', 'direction', 'adventure'] },

  // ── Education ──
  { e: '🎓', k: ['graduation', 'education', 'school', 'university', 'degree', 'tuition'] },
  { e: '✏️', k: ['pencil', 'education', 'writing', 'school', 'study'] },
  { e: '📝', k: ['notes', 'writing', 'study', 'education', 'memo'] },
  { e: '📐', k: ['ruler', 'math', 'school', 'education', 'geometry'] },
  { e: '🔬', k: ['science', 'lab', 'research', 'education', 'microscope'] },
  { e: '🔭', k: ['astronomy', 'science', 'education', 'space', 'stars'] },
  { e: '📖', k: ['book', 'reading', 'study', 'education', 'textbook'] },

  // ── Clothing & Fashion ──
  { e: '👗', k: ['dress', 'clothing', 'fashion', 'women', 'shopping'] },
  { e: '👔', k: ['shirt', 'formal', 'clothing', 'office', 'fashion'] },
  { e: '👟', k: ['shoes', 'sneakers', 'clothing', 'footwear', 'fashion'] },
  { e: '👠', k: ['heels', 'shoes', 'fashion', 'women', 'footwear'] },
  { e: '👜', k: ['bag', 'purse', 'fashion', 'accessories', 'women'] },
  { e: '🧥', k: ['coat', 'jacket', 'clothing', 'fashion', 'winter'] },
  { e: '🧣', k: ['scarf', 'winter', 'clothing', 'fashion', 'accessories'] },
  { e: '🎩', k: ['hat', 'accessories', 'fashion', 'formal'] },
  { e: '💍', k: ['ring', 'jewelry', 'accessories', 'fashion', 'engagement'] },
  { e: '💄', k: ['makeup', 'beauty', 'cosmetics', 'personal care', 'fashion'] },

  // ── Family & Personal ──
  { e: '👶', k: ['baby', 'child', 'family', 'kids', 'parenting'] },
  { e: '🧒', k: ['child', 'kids', 'family', 'school', 'parenting'] },
  { e: '👨‍👩‍👧', k: ['family', 'kids', 'parents', 'home', 'children'] },
  { e: '🎂', k: ['birthday', 'celebration', 'cake', 'party', 'gift'] },
  { e: '🎁', k: ['gift', 'present', 'celebration', 'shopping', 'surprise'] },
  { e: '💝', k: ['love', 'personal', 'gift', 'valentine', 'relationship'] },
  { e: '💐', k: ['flowers', 'gift', 'celebration', 'personal', 'garden'] },

  // ── Pets ──
  { e: '🐾', k: ['pet', 'animals', 'dog', 'cat', 'vet'] },
  { e: '🐶', k: ['dog', 'pet', 'puppy', 'animals', 'vet'] },
  { e: '🐱', k: ['cat', 'pet', 'kitten', 'animals', 'vet'] },
  { e: '🦮', k: ['guide dog', 'pet', 'dog', 'animals'] },
  { e: '🐟', k: ['fish', 'pet', 'aquarium', 'animals'] },
  { e: '🌿', k: ['plants', 'nature', 'garden', 'green', 'herb'] },

  // ── Sports & Fitness ──
  { e: '⚽', k: ['football', 'soccer', 'sport', 'fitness', 'team'] },
  { e: '🏀', k: ['basketball', 'sport', 'fitness', 'nba', 'team'] },
  { e: '🎾', k: ['tennis', 'sport', 'fitness', 'racket', 'club'] },
  { e: '⛳', k: ['golf', 'sport', 'leisure', 'club', 'fitness'] },
  { e: '🥊', k: ['boxing', 'gym', 'fitness', 'sport', 'workout'] },
  { e: '🏊', k: ['swimming', 'pool', 'fitness', 'sport', 'health'] },
  { e: '🧗', k: ['climbing', 'fitness', 'sport', 'adventure', 'gym'] },
  { e: '🎽', k: ['gym', 'sport', 'running', 'fitness', 'workout'] },
  { e: '🏃', k: ['running', 'jogging', 'fitness', 'exercise', 'sport'] },

  // ── Subscriptions & Services ──
  { e: '🔔', k: ['notification', 'subscription', 'alert', 'service', 'reminder'] },
  { e: '📧', k: ['email', 'subscription', 'communication', 'newsletter', 'service'] },
  { e: '🗞️', k: ['newspaper', 'subscription', 'news', 'media', 'magazine'] },
  { e: '📦', k: ['package', 'delivery', 'amazon', 'subscription', 'shipping', 'misc'] },
  { e: '🤝', k: ['service', 'subscription', 'contract', 'agreement', 'business'] },

  // ── Nature & Environment ──
  { e: '🌱', k: ['plant', 'nature', 'eco', 'garden', 'green', 'sustainability'] },
  { e: '🌸', k: ['flower', 'garden', 'nature', 'spring', 'beauty'] },
  { e: '🌻', k: ['sunflower', 'garden', 'nature', 'flower', 'summer'] },
  { e: '🌿', k: ['herb', 'nature', 'plant', 'green', 'garden'] },
  { e: '☀️', k: ['sun', 'summer', 'energy', 'solar', 'nature'] },
  { e: '🌙', k: ['night', 'moon', 'sleep', 'evening', 'rest'] },
  { e: '❄️', k: ['cold', 'winter', 'heating', 'snow', 'utilities'] },
  { e: '♻️', k: ['recycling', 'eco', 'green', 'environment', 'sustainable'] },

  // ── Office & Work ──
  { e: '💼', k: ['work', 'business', 'office', 'briefcase', 'professional'] },
  { e: '📋', k: ['clipboard', 'notes', 'work', 'list', 'tasks'] },
  { e: '📁', k: ['folder', 'files', 'work', 'documents', 'misc', 'other'] },
  { e: '🗂️', k: ['folders', 'files', 'organize', 'work', 'documents'] },
  { e: '📌', k: ['pin', 'reminder', 'work', 'important', 'note'] },
  { e: '✂️', k: ['scissors', 'craft', 'office', 'stationery', 'cut'] },
  { e: '📎', k: ['paperclip', 'office', 'attach', 'stationery', 'work'] },
  { e: '🖊️', k: ['pen', 'writing', 'office', 'stationery', 'sign'] },

  // ── Misc & Other ──
  { e: '⭐', k: ['star', 'favourite', 'important', 'special', 'premium'] },
  { e: '🏆', k: ['trophy', 'achievement', 'goal', 'success', 'award'] },
  { e: '🎊', k: ['celebration', 'party', 'confetti', 'special', 'event'] },
  { e: '🎉', k: ['party', 'celebration', 'birthday', 'event', 'fun'] },
  { e: '🔖', k: ['bookmark', 'save', 'note', 'label', 'tag'] },
  { e: '🏷️', k: ['tag', 'label', 'price', 'shopping', 'discount'] },
  { e: '🛠️', k: ['tools', 'repair', 'maintenance', 'fix', 'build'] },
  { e: '🧰', k: ['toolbox', 'repair', 'maintenance', 'fix', 'tools'] },
  { e: '🎀', k: ['ribbon', 'gift', 'bow', 'celebration', 'decoration'] },
  { e: '🧲', k: ['magnet', 'attraction', 'misc', 'tool', 'draw'] },
];

export function getCategoryIcons() {
  try {
    return { ...DEFAULT_ICONS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULT_ICONS };
  }
}

export function setCategoryIcon(name, icon) {
  try {
    const current = JSON.parse(localStorage.getItem(KEY) || '{}');
    current[name] = icon;
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {}
}
