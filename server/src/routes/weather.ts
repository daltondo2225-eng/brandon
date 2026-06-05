import type { FastifyInstance } from "fastify";

// Server-side weather proxy. Keeps the client thin (no direct external API
// calls) and gives us one place to cache + rate-limit. The client just calls
// GET /weather?location=City and renders the result.

interface Weather { tempF: number; description: string; localTime: string }

const WEATHER_CODE_DESC: Record<number, string> = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle",
  61: "Rain", 63: "Rain", 65: "Rain", 71: "Snow", 73: "Snow", 75: "Snow",
  80: "Showers", 81: "Showers", 82: "Showers", 95: "Storm", 96: "Storm", 99: "Storm",
};

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; weather: Weather | null }>();

async function lookup(location: string): Promise<Weather | null> {
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
  );
  const geo = await geoRes.json() as { results?: Array<{ latitude: number; longitude: number }> };
  const top = geo.results?.[0];
  if (!top) return null;
  const wRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${top.latitude}&longitude=${top.longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`,
  );
  const w = await wRes.json() as { current?: { temperature_2m?: number; weather_code?: number; time?: string } };
  const tempF = Math.round(w.current?.temperature_2m ?? 0);
  const code = w.current?.weather_code ?? -1;
  const description = WEATHER_CODE_DESC[code] ?? "—";
  // Return the location's local time as an ISO-ish string; the client formats it.
  const localTime = w.current?.time ?? "";
  return { tempF, description, localTime };
}

export async function registerWeatherRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { location?: string } }>("/weather", async (req, reply) => {
    const location = (req.query.location ?? "").trim();
    if (!location) return reply.badRequest("location is required");

    const hit = cache.get(location);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.weather ?? reply.notFound("Weather unavailable");

    try {
      const weather = await lookup(location);
      cache.set(location, { at: Date.now(), weather });
      if (!weather) return reply.notFound("Weather unavailable");
      return weather;
    } catch (err) {
      app.log.warn({ err }, "weather lookup failed");
      return reply.notFound("Weather unavailable");
    }
  });
}
