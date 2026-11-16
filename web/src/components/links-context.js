// What the panel's text needs to follow its links (#41 EDIT-14): the map's repository, where a link goes, and the follow itself.
import { createContext, useContext } from 'react';

export const LinkContext = createContext({ repo: null, target: () => null, follow: () => {} });
export const useLinks = () => useContext(LinkContext);
