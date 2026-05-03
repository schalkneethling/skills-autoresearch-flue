import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

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

  return (
    <div>
      <h1 dangerouslySetInnerHTML={{ __html: `${greeting}, ${profile.name}` }} />
      <div className="bio" dangerouslySetInnerHTML={{ __html: bio }} />
      <a href={profile.website}>Visit website</a>
      <img src={profile.avatar} alt={profile.name} />
      <script>{`window.__USER__ = ${JSON.stringify(profile)}`}</script>
    </div>
  );
}
