import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'gurupadukam_sacred_secret_key_2026';

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Access token required.' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Forbidden', message: 'Invalid or expired token.' });
    }
    req.user = decoded; // Contains id, name, email, role, location
    next();
  });
};

export const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Access restricted to approved administrative roles.' });
    }

    next();
  };
};

export const requireSuperAdmin = requireRole(['super_admin']);
export const requireAdminOrSuper = requireRole(['admin', 'super_admin']);
export const generateToken = (userPayload) => {
  return jwt.sign(userPayload, JWT_SECRET, { expiresIn: '30d' });
};
export { JWT_SECRET };

