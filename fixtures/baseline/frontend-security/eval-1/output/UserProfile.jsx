import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import DOMPurify from 'dompurify';

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '#';
    }
    return url;
  } catch {
    return '#';
  }
}

export function UserProfile({ userId }) {
  const [searchParams] = useSearchParams();
  const [profile, setProfile] = useState(null);
  const [bio, setBio] = useState('');

  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then(res => res.json())
      .then(data => {
        setProfile(data);
        setBio(data.bio);
      });
  }, [userId]);

  const greeting = searchParams.get('greeting') || 'Welcome';

  if (!profile) return <p>Loading...</p>;

  const safeBio = DOMPurify.sanitize(bio);
  const safeWebsite = sanitizeUrl(profile.website);
  // Prevent </script> injection by escaping angle brackets and ampersands
  const safeUserJson = JSON.stringify(profile)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

  return (
    <div>
      <h1>{greeting}, {profile.name}</h1>
      <div className="bio" dangerouslySetInnerHTML={{ __html: safeBio }} />
      <a href={safeWebsite}>Visit website</a>
      <img src={profile.avatar} alt={profile.name} />
      <script>{`window.__USER__ = ${safeUserJson}`}</script>
    </div>
  );
}
