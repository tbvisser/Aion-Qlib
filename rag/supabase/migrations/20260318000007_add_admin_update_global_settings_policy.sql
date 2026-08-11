-- Allow admin users to update global settings

CREATE POLICY "admin_update_global_settings"
    ON global_settings FOR UPDATE
    TO authenticated
    USING (EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.user_id = uid() AND user_profiles.is_admin = true
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.user_id = uid() AND user_profiles.is_admin = true
    ));
