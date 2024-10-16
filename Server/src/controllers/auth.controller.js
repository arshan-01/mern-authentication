import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import User from '../models/user.model.js';
import RefreshToken from '../models/refreshToken.model.js'; // Import RefreshToken model
import { ApiError, ApiResponse, asyncHandler } from '../utils/api.utils.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
} from '../utils/token.utils.js';
import { sendEmail } from '../config/email.config.js';
import { CLIENT_URL } from '../config/env.config.js';
import { PASSWORD_RESET_REQUEST_TEMPLATE } from '../emailTemplates/resetPasswordEmail.js';
import { EMAIL_VERIFICATION_TEMPLATE } from '../emailTemplates/verificationEmail.js';
import { emailVerificationStatus } from '../utils/status.utils.js';
import { decryptUserId, encryptUserId } from '../utils/userId.utils.js';
import { loginUser, PasswordUpdate, registerUser, ResetPassword, resetPasswordEmail } from '../validations/user.validation.js';

// Register a new user
export const RegisterUser = asyncHandler(async (req, res, next) => {
  // Validate request data
  await registerUser.validateAsync(req.body);
  // Extract user details from request body
  const { fullName, username, email, password, roles, isVerified } = req.body;

  // Check if the user already exists
  const userExist = await User.findOne({ email });
  if (userExist) {
    return next(new ApiError(400, 'User already exists'));
  }

  // Create a new user (password is hashed in the schema's pre-save hook)
  const user = new User({ fullName, username, email, password, roles, isVerified });
  await user.save();

  // Send verification email
  await sendVerificationEmail(user);

  res.status(201).json(new ApiResponse(201, user, 'User created successfully. Please verify your email.'));
});

// User Login
export const LoginUser = asyncHandler(async (req, res, next) => {
  // Validate request data
  await loginUser.validateAsync(req.body);
  const { email, password } = req.body;

  // Find user by email
  const user = await User.findOne({ email });
  if (!user) {
    return next(new ApiError(400, 'Invalid credentials'));
  }

  // Check password validity
  if (!(await user.comparePassword(password))) {
    return next(new ApiError(400, 'Invalid credentials'));
  }

  // Generate tokens
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  // Store refresh token in database
  await new RefreshToken({
    userId: user._id,
    token: refreshToken
  }).save();

  // Set access token in an HTTP-only cookie
  res.cookie('accessToken', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
  });

  // Set refresh token in an HTTP-only cookie
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
  });

  // Return user info without sensitive fields
  const { password: _, _id: __, ...userWithoutSensitiveInfo } = user._doc;

  res.json(new ApiResponse(200, userWithoutSensitiveInfo, 'Login successful'));
});

// Reset Password Link API
export const resetPasswordLink = asyncHandler(async (req, res) => {
  // Validate request data
  await resetPasswordEmail.validateAsync(req.body);

  let { email } = req.body;

  email = email.toLowerCase();

  const user = await User.findOne({ email });

  if (!user || user.isDeleted) {
    return res.status(404).json({ message: 'User not found' });
  }

  // Generate a reset token
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetLink = `${CLIENT_URL}/enter/reset-password/${resetToken}`;

  // Store the token and its expiry time in the user document
  user.resetPasswordToken = resetToken;
  user.resetPasswordTokenExpires = Date.now() + 3600000; // 1-hour expiration
  await user.save();

  // Send email with the reset link using the HTML template
  await sendEmail({
    to: user.email,
    subject: 'Password Reset Request',
    html: PASSWORD_RESET_REQUEST_TEMPLATE().replace('{resetURL}', resetLink) // Use the HTML template
  });

  return res.status(200).json({ message: 'Password reset link sent successfully' });
});

// Reset Password API
export const resetPassword = asyncHandler(async (req, res) => {
  // Validate request data
  await ResetPassword.validateAsync(req.body);
  let { resetToken, password, confirmPassword } = req.body;

  if (!resetToken || !password || !confirmPassword) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ message: 'Passwords do not match' });
  }

  // Find the user with the reset token and check if it's expired
  const user = await User.findOne({ resetPasswordToken : resetToken, resetPasswordTokenExpires: { $gt: Date.now() } });

  if (!user) {
    return res.status(400).json({ message: 'Invalid or expired reset token' });
  }

  // Hash the new password
  const salt = await bcrypt.genSalt(10);
  const hashPassword = await bcrypt.hash(password, salt);

  // Update the user's password and clear the reset token
  user.password = hashPassword;
  user.resetPasswordToken = undefined;
  user.resetPasswordTokenExpires = undefined;
  await user.save();

  // Return the password reset success HTML template
  res.status(200).json({ message: 'Password reset successful' });
});

// Update Password
export const UpdatePassword = asyncHandler(async (req, res, next) => {
  // Validate request data
  await PasswordUpdate.validateAsync(req.body);
  // Extract current and new password from request body
  const { currentPassword, newPassword } = req.body;

  // Find the user by their ID
  const user = await User.findById(req.user.id);
  if (!user) {
    return next(new ApiError(404, 'User not found'));
  }

  // Check if the current password is valid
  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    return next(new ApiError(400, 'Current password is incorrect'));
  }

  // Update the user's password
  user.password = newPassword; // Password will be hashed via schema pre-save hook
  await user.save();

  // Respond with a success message
  res.status(200).json(new ApiResponse(200, null, 'Password updated successfully'));
});

// Send Verification Email
export const sendVerificationEmail = async (user) => {
  try {
    // Generate the verification token
    const emailVerifyToken = crypto.randomBytes(32).toString('hex');
    const encryptedUserId = encryptUserId(user._id.toString()); // Encrypt user ID
    const emailVerifyLink = `${CLIENT_URL}/enter/verify-email/${emailVerifyToken}/${encryptedUserId}`; // Attach encrypted ID

    // Store the verification token and its expiry time in the user document
    user.emailVerificationToken = emailVerifyToken;
    user.emailVerificationTokenExpires = Date.now() + 3600000; // 1-hour expiration

    // Save the user document
    await user.save();

    // Send the verification email
    await sendEmail({
      to: user.email,
      subject: 'Email Verification',
      html: EMAIL_VERIFICATION_TEMPLATE().replace('{verificationLink}', emailVerifyLink) // Use the HTML template
    });

  } catch (error) {
    console.error('Error sending verification email:', error);
    throw new Error('Could not send verification email. Please try again later.');
  }
};

// Resend Verification Email 
export const ResendVerificationEmail = asyncHandler(async (req, res, next) => {
  const { UserId } = req.body; // Get encrypted ID from request

  // Decrypt user ID
  const userId = decryptUserId(UserId);

  // Find user by decrypted ID
  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'User not found.'
    });
  }

  if (user.isVerified) {
    return res.status(400).json({
      success: false,
      message: 'This email has already been verified.'
    });
  }

  // Resend verification email
  await sendVerificationEmail(user);

  res.status(200).json({
    success: true,
    message: 'Verification email resent.'
  });
});

// Email Verification
export const VerifyEmail = asyncHandler(async (req, res, next) => {
  const { token } = req.body;
  const { id: encryptedId } = req.query; // Extract encrypted user ID from query

  if (!token || !encryptedId) {
    return res.status(400).json({ 
      success: false,
      status: emailVerificationStatus.invalidToken,
      message: 'No verification token or ID provided.'
    });
  }

  // Decrypt the user ID
  const userId = decryptUserId(encryptedId);

  // Find the user with the email verification token and check if it's expired
  const user = await User.findOne({
    _id: userId, // Use decrypted user ID
    emailVerificationToken: token,
    emailVerificationTokenExpires: { $gt: Date.now() }, // Check if the token has not expired
  });

  if (!user) {
    return res.status(400).json({ 
      success: false,
      status: emailVerificationStatus.invalidToken,
      message: 'The verification token is invalid or has expired.'
    });
  }

  // Check if the user is already verified
  if (user.isVerified) {
    return res.status(400).json({
      success: false,
      status: emailVerificationStatus.alreadyVerified,
      message: 'This email has already been verified.'
    });
  }

  // Mark user as verified
  user.isVerified = true;
  user.emailVerificationToken = undefined; // Clear the verification token
  user.emailVerificationTokenExpires = undefined; // Clear the expiration time
  await user.save();

  res.status(200).json({
    success: true, 
    status: emailVerificationStatus.success,
    message: 'Email verification successful.'
  });
});


// User Logout
export const LogoutUser = asyncHandler(async (req, res, next) => {
  const { refreshToken } = req.cookies;

  if (refreshToken) {
    await RefreshToken.deleteOne({ token: refreshToken });
  }

  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
  res.status(200).json(new ApiResponse(200, null, 'Logout successful'));
});

// Refresh Token
export const RefreshUserToken = asyncHandler(async (req, res, next) => {
  const { refreshToken } = req.cookies;

  if (!refreshToken) {
    return next(new ApiError(401, 'No refresh token provided'));
  }

  try {
    const decoded = verifyToken(refreshToken);
    const tokenInDb = await RefreshToken.findOne({ token: refreshToken });

    if (!tokenInDb || tokenInDb.userId.toString() !== decoded.id) {
      return next(new ApiError(401, 'Invalid refresh token'));
    }

    // Generate new access token
    const accessToken = generateAccessToken({ id: decoded.id });

    // Set new access token in cookie
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
    });

    res.json(new ApiResponse(200, { accessToken }, 'Token refreshed successfully'));
  } catch (error) {
    return next(new ApiError(401, 'Invalid or expired refresh token'));
  }
});
