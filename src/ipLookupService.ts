import {
  AddressNotFoundError,
  Reader,
  type ReaderModel,
  type City,
} from '@maxmind/geoip2-node';

function cityToPlain(city: City): Record<string, unknown> {
  return JSON.parse(JSON.stringify(city)) as Record<string, unknown>;
}

export class IpLookupService {
  private reader: ReaderModel | null = null;

  constructor(private databasePath: string) {}

  get path(): string {
    return this.databasePath;
  }

  isLoaded(): boolean {
    return this.reader != null;
  }

  /**
   * Opens (or reopens) the MMDB at the current {@link path}.
   * Call after a MaxMind sync so the new file is picked up.
   */
  async reloadDatabase(): Promise<void> {
    this.reader = await Reader.open(this.databasePath);
  }

  /**
   * Sets the path and reloads the database from that location.
   */
  async setDatabasePath(newPath: string): Promise<void> {
    this.databasePath = newPath;
    await this.reloadDatabase();
  }

  /**
   * GeoIP2 City (or Enterprise with a City-shaped record): all fields the database returns for the IP.
   * @throws {@link AddressNotFoundError} if the IP is not in the tree
   * @throws Error if no database has been loaded yet
   */
  lookup(ip: string): Record<string, unknown> {
    if (!this.reader) {
      throw new Error('IP database not loaded');
    }
    const city = this.reader.city(ip);
    return cityToPlain(city);
  }
}

export { AddressNotFoundError };
