import { dbRun, dbInitPromise } from './database.js';

async function seed() {
  await dbInitPromise;
  console.log("DB initialized. Seeding purohits...");

  const purohits = [
    {
      id: 'purohit_1',
      name: 'Sri Veda Narayana Sastri',
      specialization: 'Satyanarayana Swamy Vratam, Rudrabhishekam',
      rating: 4.9,
      fee: 2500,
      image: 'https://images.unsplash.com/photo-1544717305-2782549b5136?q=80&w=400',
      location: 'Hyderabad',
      bio: 'Experienced priest with 18 years in Yajurveda and Smartasutras rituals.',
      credentials: 'Tirupati Veda Pathashala Gold Medalist',
      email: 'narayana@gurupadukam.com',
      phone: '9988776655'
    },
    {
      id: 'purohit_2',
      name: 'Acharya Sharma',
      specialization: 'Marriage (Vivaham), Upanayanam',
      rating: 4.8,
      fee: 5000,
      image: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?q=80&w=400',
      location: 'Bengaluru',
      bio: 'Specialist in grand weddings, Vaastu Shanti, and traditional ceremonies.',
      credentials: 'M.A. Sanskrit & Agama Ratna',
      email: 'sharma@gurupadukam.com',
      phone: '9876543211'
    },
    {
      id: 'purohit_3',
      name: 'Pt. Vasudevan Shastri',
      specialization: 'Chandi Homam, Grihapravesham',
      rating: 5.0,
      fee: 4500,
      image: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?q=80&w=400',
      location: 'Chennai',
      bio: 'Expert in Rigveda chanting, Maha Chandi Homam, and consecration ceremonies.',
      credentials: 'Kanchi Kamakoti Peetham Recognized',
      email: 'vasudevan@gurupadukam.com',
      phone: '9443322110'
    },
    {
      id: 'purohit_4',
      name: 'Acharya Anantha Dikshit',
      specialization: 'Namakaranam, Sudarsana Homam',
      rating: 4.7,
      fee: 3000,
      image: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?q=80&w=400',
      location: 'Khammam',
      bio: 'Dedicated Smarta scholar specializing in Samskaras and astrology consultations.',
      credentials: 'Bhadrachalam Devasthanam Senior Scholar',
      email: 'anantha@gurupadukam.com',
      phone: '9112233445'
    }
  ];

  try {
    for (const p of purohits) {
      await dbRun(
        `INSERT OR REPLACE INTO purohits (id, name, specialization, rating, fee, image, location, bio, credentials, email, phone) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.name, p.specialization, p.rating, p.fee, p.image, p.location, p.bio, p.credentials, p.email, p.phone]
      );
    }
    console.log("Successfully seeded 4 vetted purohits.");
  } catch (err) {
    console.error("Error seeding purohits:", err);
  }
  process.exit(0);
}

seed();
