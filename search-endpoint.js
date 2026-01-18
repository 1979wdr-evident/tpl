// Add this to your server.js after the /health endpoint

// Search endpoint - uses College Scorecard for institution search
app.get('/api/ipeds/search', async (req, res) => {
  try {
    const { name, limit = 10 } = req.query;
    
    if (!name) {
      return res.status(400).json({ error: 'name parameter required' });
    }
    
    console.log(`Searching for: "${name}"`);
    
    // Use College Scorecard API for search
    const apiKey = 'wvO1UtAGFz7RQXxj3lRfbaIu9ed2USO39n82A8zL';
    const url = `https://api.data.gov/ed/collegescorecard/v1/schools.json?` +
      `school.name=${encodeURIComponent(name)}` +
      `&api_key=${apiKey}` +
      `&_fields=id,school.name,school.city,school.state,school.school_url` +
      `&_per_page=${limit}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`College Scorecard API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Transform to expected format
    const results = (data.results || []).map(school => ({
      unitid: school.id,
      name: school['school.name'],
      city: school['school.city'],
      state: school['school.state'],
      url: school['school.school_url'] || ''
    }));
    
    res.json({ results });
    
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});
